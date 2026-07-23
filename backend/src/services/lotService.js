import { query } from '../db.js'

// Pin an expiry to its Lagos calendar day (YYYY-MM-DD) so it stays stable through
// JSON round-trips and re-credits regardless of DB session timezone.
const ymd = d => d ? new Date(d).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }) : null

// Split a drawn-lots array into the first `keepQty` units (soonest-expiry first,
// as returned by debit) and the remainder. Used by a partial dispute to divide
// the dispatched lots into what the receiver kept vs what went back.
export function splitLots(lots, keepQty) {
  let keep = Math.round(keepQty)
  const kept = [], rest = []
  for (const l of lots || []) {
    if (keep <= 0) { rest.push(l); continue }
    const take = Math.min(l.qty, keep)
    if (take > 0) kept.push({ batch: l.batch, expiry: l.expiry, qty: take })
    if (l.qty - take > 0) rest.push({ batch: l.batch, expiry: l.expiry, qty: l.qty - take })
    keep -= take
  }
  return { kept, rest }
}

// The one place stock movements record their per-batch effect on the lot ledger
// (stock_lot), kept in lockstep with each location's total quantity so the
// invariant sum(lots) == quantity always holds. Every method takes the caller's
// transaction `exec` so the lot change commits or rolls back with the quantity
// change it accompanies.
//
// A "bin" is { facility_id, commodity_id, location_type, site_name? } where
// location_type is store | dispensary | dsd | sdp and site_name names the DSD/SDP
// site (null for store/dispensary).
//
// Phase 2 maintains the ledger; it does NOT enforce yet (that's phase 3). Because
// the seed guarantees coverage and a valid quantity debit never exceeds what's on
// hand, a FEFO debit always finds enough — so the ledger stays consistent without
// blocking. `debit` returns a shortfall count for the verify script to notice if
// that assumption is ever violated (e.g. an un-seeded bin).
export class LotService {
  // Add qty to a specific (batch, expiry) lot in a bin. Upserts the lot.
  static async credit(exec = query, bin, { batch = null, expiry = null, qty, section = null }) {
    const n = Math.round(qty)
    if (!(n > 0)) return
    await exec(
      `insert into stock_lot (facility_id, commodity_id, location_type, site_name, batch_number, expiry_date, quantity, section)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (facility_id, commodity_id, location_type,
                    coalesce(site_name,''), coalesce(batch_number,''), coalesce(expiry_date,'0001-01-01'::date))
       do update set quantity = stock_lot.quantity + excluded.quantity, updated_at = now()`,
      [bin.facility_id, bin.commodity_id, bin.location_type, bin.site_name || null, batch, expiry || null, n, section]
    )
  }

  // Credit several lots at once (e.g. what a transfer/redistribution carried).
  static async creditMany(exec, bin, lots, section = null) {
    for (const l of lots || []) {
      await this.credit(exec, bin, { batch: l.batch, expiry: l.expiry, qty: l.qty, section })
    }
  }

  // Remove qty from a bin. If `prefer.batch` is given, draw that batch first, then
  // FEFO (soonest-expiry first, unknown-expiry last) for any remainder; otherwise
  // pure FEFO. Returns the lots actually drawn — [{ batch, expiry, qty }] — so a
  // transfer can carry them to the destination, plus `shortfall` if the bin's lots
  // couldn't cover qty (should be 0 post-seed).
  static async debit(exec, bin, qty, prefer = {}) {
    let need = Math.round(qty)
    const drawn = []
    if (need <= 0) return { drawn, shortfall: 0 }
    const { rows } = await exec(
      `select id, batch_number, expiry_date, quantity
         from stock_lot
        where facility_id=$1 and commodity_id=$2 and location_type=$3
          and coalesce(site_name,'') = coalesce($4,'') and quantity > 0
        order by (case when $5::text is not null and coalesce(batch_number,'') = coalesce($5,'') then 0 else 1 end),
                 expiry_date asc nulls last, id`,
      [bin.facility_id, bin.commodity_id, bin.location_type, bin.site_name || null, prefer.batch || null]
    )
    for (const l of rows) {
      if (need <= 0) break
      const take = Math.min(l.quantity, need)
      await exec('update stock_lot set quantity = quantity - $2, updated_at = now() where id = $1', [l.id, take])
      drawn.push({ batch: l.batch_number, expiry: ymd(l.expiry_date), qty: take })
      need -= take
    }
    // Drop any lot this left at zero so the ledger stays tidy.
    await exec(
      `delete from stock_lot
        where facility_id=$1 and commodity_id=$2 and location_type=$3
          and coalesce(site_name,'') = coalesce($4,'') and quantity <= 0`,
      [bin.facility_id, bin.commodity_id, bin.location_type, bin.site_name || null]
    )
    return { drawn, shortfall: need }
  }

  // Move qty between two bins in the same transaction, preserving batch/expiry:
  // FEFO-debit the source, credit the destination with exactly what was drawn.
  // Returns the lots moved. Used by internal / DSD / SDP redistribution.
  static async move(exec, fromBin, toBin, qty, prefer = {}, section = null) {
    const { drawn } = await this.debit(exec, fromBin, qty, prefer)
    await this.creditMany(exec, toBin, drawn, section)
    return drawn
  }
}
