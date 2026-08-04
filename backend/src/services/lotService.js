import { query } from '../db.js'

// Pin an expiry to its Lagos calendar day (YYYY-MM-DD) so it stays stable through
// JSON round-trips and re-credits regardless of DB session timezone. Returns null
// for anything unparseable (a malformed free-typed note expiry) or implausible (a
// 2-digit-year typo that lands in year 0028, etc.) — those become unknown-expiry
// lots rather than crashing an insert into a date column.
export const ymd = d => {
  if (!d) return null
  const t = new Date(d)
  if (isNaN(t.getTime())) return null
  const s = t.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const year = +s.slice(0, 4)
  return year >= 2000 && year <= 2100 ? s : null
}

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

// The authoritative on-hand quantity of a bin, from the real stock tables (the
// numbers users see on Stock Levels). The lot ledger is meant to always sum to
// this; when it has drifted behind (a path changed the aggregate without a matching
// lot move, or a bin was never fully seeded), we trust this and top the ledger up.
async function binSoh(exec, bin) {
  if (bin.location_type === 'sdp') {
    const { rows } = await exec(`select quantity from sdp_stock where facility_id=$1 and coalesce(sdp_name,'')=coalesce($2,'') and commodity_id=$3`, [bin.facility_id, bin.site_name || null, bin.commodity_id])
    return rows[0]?.quantity || 0
  }
  if (bin.location_type === 'dsd') {
    const { rows } = await exec(`select quantity from dsd_stock where facility_id=$1 and coalesce(dsd_site_name,'')=coalesce($2,'') and commodity_id=$3`, [bin.facility_id, bin.site_name || null, bin.commodity_id])
    return rows[0]?.quantity || 0
  }
  const { rows } = await exec(`select quantity from stock where facility_id=$1 and commodity_id=$2 and location_type=$3`, [bin.facility_id, bin.commodity_id, bin.location_type])
  return rows[0]?.quantity || 0
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
      // ymd() guards against a malformed/implausible expiry (e.g. free-typed in a
      // transfer note) reaching the date column — it becomes an unknown-expiry lot.
      [bin.facility_id, bin.commodity_id, bin.location_type, bin.site_name || null, batch, ymd(expiry), n, section]
    )
  }

  // Credit several lots at once (e.g. what a transfer/redistribution carried).
  static async creditMany(exec, bin, lots, section = null) {
    for (const l of lots || []) {
      await this.credit(exec, bin, { batch: l.batch, expiry: l.expiry, qty: l.qty, section })
    }
  }

  // Remove qty from a bin.
  //   opts.batch    — draw only this batch (an explicit pick); otherwise FEFO.
  //   opts.enforce  — phase-3 hard block: never draw EXPIRED lots, and throw (409)
  //                   if the eligible lots can't cover qty. Off by default so the
  //                   seed/reconcile/dispute paths still move stock unconditionally.
  // Draw order: soonest-expiry first, unknown-expiry (null) last. Returns the lots
  // actually drawn — [{ batch, expiry, qty }] — so a transfer can carry them, plus
  // `shortfall` (0 unless a non-enforced bin was short).
  static async debit(exec, bin, qty, opts = {}) {
    const { batch = null, enforce = false } = opts
    let need = Math.round(qty)
    const drawn = []
    if (need <= 0) return { drawn, shortfall: 0 }

    const today = ymd(new Date())
    const isExpired = l => { const e = ymd(l.expiry_date); return e != null && e < today }
    // Load the eligible pool: the picked batch only (if any); expired lots excluded
    // when enforcing. FEFO order — soonest real expiry first, unknown-expiry last.
    const loadPool = async () => {
      const { rows } = await exec(
        `select id, batch_number, expiry_date, quantity
           from stock_lot
          where facility_id=$1 and commodity_id=$2 and location_type=$3
            and coalesce(site_name,'') = coalesce($4,'') and quantity > 0`,
        [bin.facility_id, bin.commodity_id, bin.location_type, bin.site_name || null]
      )
      const total = rows.reduce((s, l) => s + l.quantity, 0)
      let pool = batch != null ? rows.filter(l => (l.batch_number || '') === (batch || '')) : rows.slice()
      if (enforce) pool = pool.filter(l => !isExpired(l))
      pool.sort((a, b) => {
        const ea = ymd(a.expiry_date), eb = ymd(b.expiry_date)
        if (ea && eb) return ea < eb ? -1 : ea > eb ? 1 : 0
        return ea ? -1 : eb ? 1 : 0
      })
      return { pool, total }
    }

    let { pool, total } = await loadPool()

    if (enforce) {
      let eligible = pool.reduce((s, l) => s + l.quantity, 0)
      // DEPENDS ON the caller having verified the bin covers `need` BEFORE it
      // decremented (LogService.assertBinCovers). Without that check a bin clamped
      // to 0 made (soh + need) look like real stock, so this "heal" minted phantom
      // lots to cover a draw the shelf never had — the overdraft then committed.
      // Self-heal a ledger that has drifted BEHIND the authoritative bin stock. The
      // caller already decremented the aggregate by `need`, so the ledger's correct
      // pre-debit total is (aggregate + need). If the pool can't cover `need` but the
      // aggregate can, top the ledger up to match (unknown-expiry) and proceed — a
      // lagging ledger must never block real stock. Only a genuine aggregate shortage
      // (or a short pick of a specific batch) blocks. This restores sum(lots)==qty.
      if (eligible < need && batch == null) {
        const soh = await binSoh(exec, bin)
        const topUp = Math.max(0, (soh + need) - total)
        if (topUp > 0) {
          await this.credit(exec, bin, { qty: topUp })
          ;({ pool } = await loadPool())
          eligible = pool.reduce((s, l) => s + l.quantity, 0)
        }
      }
      if (eligible < need) {
        const e = new Error(batch != null
          ? `Only ${eligible} of batch ${batch || '(unbatched)'} available to dispense (non-expired). Requested ${need}.`
          : `Only ${eligible} non-expired unit(s) available. Requested ${need}. Adjust out expired stock or record a shortage.`)
        e.status = 409
        throw e
      }
    }

    for (const l of pool) {
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

  // Restore the invariant sum(lots) == authoritative bin stock. Used before the
  // batch picker reads a bin (so it shows the right "N left") and as a repair for
  // ledgers that drifted. Shortfall is topped up as an unknown-expiry lot; excess
  // is trimmed FEFO. Returns the applied delta (0 when already in sync).
  static async reconcile(exec, bin) {
    const soh = await binSoh(exec, bin)
    const { rows } = await exec(
      `select coalesce(sum(quantity),0) t from stock_lot
        where facility_id=$1 and commodity_id=$2 and location_type=$3
          and coalesce(site_name,'') = coalesce($4,'')`,
      [bin.facility_id, bin.commodity_id, bin.location_type, bin.site_name || null]
    )
    const ledger = Number(rows[0].t)
    const diff = soh - ledger
    if (diff > 0) await this.credit(exec, bin, { qty: diff })
    else if (diff < 0) await this.debit(exec, bin, -diff)   // non-enforced FEFO trim
    return diff
  }

  // Move qty between two bins in the same transaction, preserving batch/expiry:
  // FEFO-debit the source, credit the destination with exactly what was drawn.
  // Returns the lots moved. Used by internal / DSD / SDP redistribution.
  static async move(exec, fromBin, toBin, qty, opts = {}, section = null) {
    const { drawn } = await this.debit(exec, fromBin, qty, opts)
    await this.creditMany(exec, toBin, drawn, section)
    return drawn
  }
}
