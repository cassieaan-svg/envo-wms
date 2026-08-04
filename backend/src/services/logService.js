import { query, withTransaction } from '../db.js'
import { StockService } from './stockService.js'
import { LotService, ymd } from './lotService.js'

// Nested commodity object matching the frontend's `commodities(id,name,category,unit)`
// embedded select, rebuilt with json_build_object (PostgREST replacement).
const COMM4_OBJ = `
  json_build_object('id', c.id, 'name', c.name, 'category', c.category, 'unit', c.unit) as commodities`

// Nested facility object — reports/admin views read row.facilities?.name/.lga.
const FAC_OBJ = `
  json_build_object('id', f.id, 'name', f.name, 'lga', f.lga, 'state', f.state) as facilities`

// Inclusive day bounds for a YYYY-MM-DD date filter (mirrors the old gte/lte).
function dayBounds(date) {
  return [`${date}T00:00:00`, `${date}T23:59:59`]
}

// Category → section map (mirrors the frontend's SECTION_CATEGORIES). The section
// is deterministically implied by the commodity, so we enforce it server-side:
// if a caller omits `section` on a log write, derive it from the commodity's
// category. This guarantees every log row is section-tagged regardless of which
// page recorded it — a store manager's section-filtered Activity Log then never
// silently drops site (SDP/DSD) records that forgot to pass section.
const SECTION_BY_CATEGORY = {
  'Pharmacy drugs': 'pharmacy',
  'Medical supplies': 'pharmacy',
  'RTKs': 'lab',
  'Lab reagents': 'lab',
  'Lab consumables': 'lab',
}

// Resolve a log row's section: use the caller-provided value, else derive it from
// the commodity's category. Runs inside the caller's transaction (exec). Returns
// null only when neither is available (unmapped/blank category).
async function resolveSection(section, commodityId, exec) {
  if (section) return section
  const { rows } = await exec('select category from commodities where id = $1', [commodityId])
  return SECTION_BY_CATEGORY[rows[0]?.category] || null
}

// Enforcement switch for the bin-stock precondition below. OFF by default, and
// deliberately opt-in (=== 'true'), so deploying the Stock Count work cannot start
// refusing consumption as a side effect.
//
// Rollout: a bin whose stock on hand is wrong will refuse consumption once this is
// on — correct behaviour, but it surfaces as "the app won't let me record" at every
// facility whose figures have drifted (57 bins across 48 facilities at last audit).
// Turn it on once those bins have been physically counted through the Stock Count
// screen. Read per call, so flipping it needs a restart but no code change.
const enforceBinStock = () => process.env.ENFORCE_BIN_STOCK === 'true'

// Guard a consumption against the bin's actual stock on hand BEFORE any row is
// written. Returns true when the bin covers the draw (or nothing is being drawn),
// false when it does not and enforcement is off. Throws 409 when it does not and
// enforcement is on — inside the caller's transaction, so a refused consumption
// rolls back and leaves no dispense_log row behind.
//
// This is the invariant the bin card depends on: a bin's stock on hand must always
// equal the sum of its recorded movements. Allowing an overdraft (by clamping the
// decrement at 0) breaks it — the movement is recorded but the stock never moved,
// and the difference reappears as a phantom opening balance. qty 0 is a legitimate
// "nothing consumed today" record and is always allowed.
async function assertBinCovers(exec, soh, qty, commodityId, binLabel) {
  if (qty <= 0 || soh >= qty) return true
  const name = (await exec('select name from commodities where id = $1', [commodityId])).rows[0]?.name || 'this commodity'
  const msg = `Cannot record ${qty} consumed: ${binLabel} holds only ${soh} of ${name}. ` +
    `Record the stock movement into ${binLabel} first (intake or redistribution), then record the consumption.`
  if (!enforceBinStock()) {
    // Log it so the overdrafts are measurable during the transition, then fall
    // through to the old clamped decrement rather than blocking the user.
    console.warn(`[bin-stock] overdraft ALLOWED (ENFORCE_BIN_STOCK is off): ${msg}`)
    return false
  }
  const e = new Error(msg)
  e.status = 409
  throw e
}

// The reason carried by an adjustment DERIVED from a physical stock count. It
// replaces the retired 'Physical count correction', which staff entered as a target
// ("the shelf holds 200") while the system read it as a delta ("remove 200 more") —
// the cause of the repeated over-deductions in the opening-balance audit. Counts now
// go through recordStockCount(); this reason marks their derived ledger entry so
// book corrections stay distinguishable from real stock loss (Expired/Damaged/Lost).
export const STOCK_COUNT_REASON = 'Stock count variance'

// Read a bin's authoritative stock on hand, whichever table backs it. Bins live in
// three tables (stock for store/dispensary, dsd_stock, sdp_stock); counting must
// address all of them, since the audit found drift in every bin type.
async function binStockOnHand(exec, { facility_id, commodity_id, location_type, site_name }) {
  if (location_type === 'dsd' || location_type === 'sdp') {
    const tbl = location_type === 'dsd' ? 'dsd_stock' : 'sdp_stock'
    const col = location_type === 'dsd' ? 'dsd_site_name' : 'sdp_name'
    const { rows } = await exec(
      `select quantity from ${tbl}
        where facility_id = $1 and commodity_id = $2
          and lower(btrim(${col})) = lower(btrim($3)) limit 1`,
      [facility_id, commodity_id, site_name]
    )
    return rows[0]?.quantity ?? 0
  }
  const { rows } = await exec(
    `select quantity from stock
      where facility_id = $1 and commodity_id = $2 and location_type = $3 limit 1`,
    [facility_id, commodity_id, location_type]
  )
  return rows[0]?.quantity ?? 0
}

// Set a bin's stock to an absolute figure (upsert). Assignment, not a delta — the
// counted shelf wins outright, which is what stops repeated counts from compounding.
// Only ever called from recordStockCount: physical observation is the sole warrant
// for writing stock directly rather than through a movement.
async function setBinStockOnHand(exec, { facility_id, commodity_id, location_type, site_name }, qty) {
  if (location_type === 'dsd' || location_type === 'sdp') {
    const tbl = location_type === 'dsd' ? 'dsd_stock' : 'sdp_stock'
    const col = location_type === 'dsd' ? 'dsd_site_name' : 'sdp_name'
    await exec(
      `insert into ${tbl} (facility_id, ${col}, commodity_id, quantity)
       values ($1,$2,$3,$4)
       on conflict (facility_id, ${col}, commodity_id)
       do update set quantity = $4, updated_at = now()`,
      [facility_id, site_name, commodity_id, qty]
    )
    return
  }
  await exec(
    `insert into stock (facility_id, commodity_id, location_type, quantity)
     values ($1,$2,$3,$4)
     on conflict (facility_id, commodity_id, location_type)
     do update set quantity = $4, updated_at = now()`,
    [facility_id, commodity_id, location_type, qty]
  )
}

// Shared facility/commodity/date-range/section filters for the log history
// queries. Mutates `conds`/`params` in place (params is 1-based for $n). Covers
// both the per-facility per-day "recent entries" view and the multi-facility
// date-range report aggregation.
//   facilityId  — single facility (when the route pinned one)
//   facilityIds — array of facilities (scoped/admin multi-facility); [] = none
//   commodityIds, section, date (single day), from/to (range on dateField)
function applyLogFilters({ conds, params, dateField, facilityId, facilityIds, commodityIds, categories, date, from, to, section }) {
  if (facilityId) { params.push(facilityId); conds.push(`l.facility_id = $${params.length}`) }
  else if (Array.isArray(facilityIds)) { params.push(facilityIds); conds.push(`l.facility_id = any($${params.length})`) }

  if (Array.isArray(commodityIds) && commodityIds.length) { params.push(commodityIds); conds.push(`l.commodity_id = any($${params.length})`) }
  // Section enforcement (server-side): restrict to the caller's commodity categories,
  // joined via commodities c. Robust even where the denormalized l.section is null.
  if (Array.isArray(categories) && categories.length) { params.push(categories); conds.push(`c.category = any($${params.length})`) }
  if (section) { params.push(section); conds.push(`l.section = $${params.length}`) }

  if (date) {
    const [start, end] = dayBounds(date)
    params.push(start, end); conds.push(`l.${dateField} >= $${params.length - 1} and l.${dateField} <= $${params.length}`)
  } else {
    if (from) { params.push(from); conds.push(`l.${dateField} >= $${params.length}`) }
    if (to)   { params.push(to);   conds.push(`l.${dateField} <= $${params.length}`) }
  }
}

// Log-edit support (EditModal). Maps the frontend's record _type to its table and
// the metadata columns that edit is allowed to change. Stock reconciliation is NOT
// done here — the client adjusts stock separately (matching the original flow).
const LOG_TABLES = { dispense: 'dispense_log', intake: 'intake_log', adjustment: 'stock_adjustment_log' }
const LOG_EDIT_FIELDS = {
  dispense:   ['quantity', 'dispensed_at', 'notes', 'edited_by'],
  intake:     ['quantity', 'batch_number', 'expiry_date', 'supplier_source', 'condition_on_arrival', 'edited_by'],
  adjustment: ['quantity', 'reason', 'notes', 'batch_number', 'expiry_date', 'edited_by'],
}

export class LogService {
  /** Fetch one log row by type + id (for edit scoping/existence). Null if absent. */
  static async getLogRow(type, id) {
    const table = LOG_TABLES[type]
    if (!table) throw new Error(`Unknown log type: ${type}`)
    const { rows } = await query(`select * from ${table} where id = $1`, [id])
    return rows[0] || null
  }

  /**
   * Update a log row's whitelisted fields, and — for records that credited a
   * specific STORE lot (an intake or an Increase adjustment) — mirror any
   * batch/expiry/quantity change onto the lot ledger so the Monitoring expiry
   * view stays in step. Dispense and Decrease adjustments debit FEFO and carry no
   * lot identity, so their edits stay metadata-only. Runs in one transaction.
   */
  static async updateLog(type, id, fields = {}) {
    const table = LOG_TABLES[type]
    const allowed = LOG_EDIT_FIELDS[type]
    if (!table) throw new Error(`Unknown log type: ${type}`)

    const old = await this.getLogRow(type, id)
    if (!old) return null

    const sets = []
    const params = [id]
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        params.push(k === 'quantity' ? parseInt(fields[k]) : fields[k])
        sets.push(`${k} = $${params.length}`)
      }
    }
    if (!sets.length) throw new Error('No updatable fields provided')

    return await withTransaction(async exec => {
      const { rows } = await exec(`update ${table} set ${sets.join(', ')} where id = $1 returning *`, params)
      const updated = rows[0] || null

      const isStoreCredit = type === 'intake' || (type === 'adjustment' && old.adjustment_type === 'Increase')
      if (updated && isStoreCredit) {
        await this._syncLotsOnEdit(exec, { facility_id: old.facility_id, commodity_id: old.commodity_id }, {
          oldBatch: old.batch_number,   oldExpiry: old.expiry_date, oldQty: old.quantity,
          newBatch: updated.batch_number, newExpiry: updated.expiry_date, newQty: updated.quantity,
        })
      }
      return updated
    })
  }

  /**
   * Mirror an intake/Increase-adjustment edit onto the lot ledger so the Monitoring
   * / expiry views (and the per-batch stock breakdown) stay honest. Three parts:
   *
   *  1. IDENTITY. What changed decides how the corrected label is applied:
   *     - Expiry corrected on a BATCH → a batch has exactly one true expiry, so
   *       relabel EVERY lot of that batch, in the store AND every bin the stock
   *       moved to (dispensary/DSD/SDP), whatever (possibly stale) expiry it holds,
   *       onto the new date. This is self-healing: it fixes the edit even if a past
   *       edit or the seed left the ledger out of sync — the reason a plain expiry
   *       edit used to "not take". Skipped only for an AMBIGUOUS batch (its own
   *       credit records disagree on the expiry), which then falls back to (2)'s
   *       precise move so we never guess.
   *     - Batch renumbered, or an UNBATCHED expiry change → we can't key on the
   *       batch, so move only the record's own contribution: the exact old identity
   *       in the store (clamped to what's on hand, unknown-expiry lots included),
   *       plus the same exact relabel in the other bins.
   *  2. QUANTITY. Apply the (newQty − oldQty) delta to the store's corrected
   *     identity — grow it, or FEFO-trim it (never negative).
   *
   * The aggregate `stock` total is reconciled separately by the client.
   */
  static async _syncLotsOnEdit(exec, key, args) {
    // 1. Best-effort relabel of every bin (incl. store) to the corrected identity,
    //    plus the quantity delta. Fixes the common cases and is all that survives
    //    when the store can't be cleanly rebuilt below.
    await this._relabelAndDelta(exec, key, args)
    // 2. Authoritative pass: rebuild the STORE bin straight from the records so an
    //    edit's batch, expiry AND quantity always surface on Stock Levels — even when
    //    the ledger drifted so far that step 1 had nothing to match (e.g. a batch was
    //    renamed on a record earlier, orphaning its lot). No-op when it can't be
    //    reconciled to the store's authoritative SOH, leaving step 1's result intact.
    await this._rebuildStoreFromRecords(exec, key)
    // 3. Heal orphaned batches across EVERY bin. When a batch was renamed on the
    //    record, the old batch is left in the ledger — in the store AND any site the
    //    stock had moved to (dispensary/DSD/SDP) — and no earlier step can find it,
    //    because they all key off the record's current batch. When the records credit
    //    exactly one identity (the common case), relabel every on-hand lot onto it.
    await this._healOrphanedBins(exec, key)
  }

  // When a commodity's records credit exactly ONE (batch, expiry) — the common case —
  // every on-hand lot, in every bin, must be that identity. Relabel any lot that isn't
  // (an orphaned batch a rename left behind) onto it, preserving each bin's quantity.
  // Skipped when the records carry several identities, where a blanket relabel would
  // guess — those are handled by the exact-move / whole-batch passes above.
  static async _healOrphanedBins(exec, { facility_id, commodity_id }) {
    const p = [facility_id, commodity_id]
    const { rows: recs } = await exec(`
      select coalesce(nullif(btrim(coalesce(batch_number,'')),''),'') batch,
             to_char(expiry_date,'YYYY-MM-DD') exp
        from (
          select batch_number, expiry_date, quantity q from intake_log
            where facility_id=$1 and commodity_id=$2
          union all
          select batch_number, expiry_date, quantity q from stock_adjustment_log
            where facility_id=$1 and commodity_id=$2 and adjustment_type='Increase'
          union all
          select batch_number, expiry_date, -quantity q from stock_adjustment_log
            where facility_id=$1 and commodity_id=$2 and adjustment_type='Decrease'
        ) c group by 1, 2 having sum(q) > 0`, p)
    if (recs.length !== 1) return               // 0 or many identities — not safe to blanket-relabel
    const target = { batch: recs[0].batch || null, exp: recs[0].exp || null }

    const { rows: lots } = await exec(`
      select id, location_type, coalesce(site_name,'') site, section,
             coalesce(nullif(btrim(coalesce(batch_number,'')),''),'') batch,
             to_char(expiry_date,'YYYY-MM-DD') exp, quantity
        from stock_lot where facility_id=$1 and commodity_id=$2 and quantity > 0`, p)
    let healed = false
    for (const l of lots) {
      if ((l.batch || '') === (target.batch || '') && (l.exp || '') === (target.exp || '')) continue
      await exec('update stock_lot set quantity = quantity - $2, updated_at = now() where id = $1', [l.id, l.quantity])
      await LotService.credit(exec, { facility_id, commodity_id, location_type: l.location_type, site_name: l.site || null },
        { batch: target.batch, expiry: target.exp, qty: l.quantity, section: l.section })
      healed = true
    }
    if (healed) await exec(`delete from stock_lot where facility_id=$1 and commodity_id=$2 and quantity <= 0`, p)
  }

  static async _relabelAndDelta(exec, key, { oldBatch, oldExpiry, oldQty, newBatch, newExpiry, newQty }) {
    const oldB = oldBatch || null, newB = newBatch || null
    const oldE = ymd(oldExpiry), newE = ymd(newExpiry)
    const oQ = Math.max(0, Math.round(Number(oldQty)) || 0)
    const nQ = Math.max(0, Math.round(Number(newQty)) || 0)
    const store = { ...key, location_type: 'store', site_name: null }
    const batchChanged = (oldB || '') !== (newB || '')
    const expiryChanged = (oldE || '') !== (newE || '')

    // Move the record's own contribution from the exact old identity to the new one:
    // the store lot (unknown-expiry lots included), then the same exact relabel in
    // the other bins. Used for batch renumbers and unbatched/ambiguous expiry edits.
    const exactMove = async () => {
      if (oQ > 0) {
        const moved = await this._drawForRelabel(exec, store, { batch: oldB, expiry: oldE }, oQ)
        if (moved > 0) await LotService.credit(exec, store, { batch: newB, expiry: newE, qty: moved })
      }
      await this._relabelExactOtherBins(exec, key,
        { fromBatch: oldB, fromExpiry: oldE, toBatch: newB, toExpiry: newE })
    }

    if (batchChanged) {
      await exactMove()
    } else if (newB) {
      // Batched edit: keep the WHOLE batch aligned to the record's current expiry —
      // idempotent and run every time, so it also self-heals a ledger that drifted
      // (e.g. a prior edit whose old value no longer matches, which is why a plain
      // re-save used to do nothing). Ambiguous batches — records disagree on the
      // expiry — fall back to moving only this record's own exact contribution.
      if (await this._batchExpiryAmbiguous(exec, key, newB)) {
        if (expiryChanged) await exactMove()
      } else {
        await this._relabelWholeBatch(exec, key, newB, newE)
      }
    } else if (expiryChanged) {
      await exactMove()   // unbatched — can only match the exact old identity
    }

    const delta = nQ - oQ
    if (delta > 0) await LotService.credit(exec, store, { batch: newB, expiry: newE, qty: delta })
    else if (delta < 0) await LotService.debit(exec, store, -delta, { batch: newB })
  }

  // Draw up to `want` units from `bin` to relabel: first the exact (batch, expiry)
  // lot, then any UNKNOWN-expiry lot (null expiry — the seed placeholder that holds
  // historical stock). Returns how many were actually drawn (<= want, <= on hand).
  // Emptied lots are removed. Deduped by lot id so a lot never double-counts.
  static async _drawForRelabel(exec, bin, { batch, expiry }, want) {
    const base = [bin.facility_id, bin.commodity_id, bin.location_type, bin.site_name || null]
    const { rows: exact } = await exec(
      `select id, quantity from stock_lot
        where facility_id=$1 and commodity_id=$2 and location_type=$3 and coalesce(site_name,'')=coalesce($4,'')
          and coalesce(batch_number,'')=coalesce($5,'')
          and coalesce(expiry_date,'0001-01-01'::date)=coalesce($6::date,'0001-01-01'::date)
          and quantity > 0
        order by id`, [...base, batch, ymd(expiry)])
    const { rows: unknown } = await exec(
      `select id, quantity from stock_lot
        where facility_id=$1 and commodity_id=$2 and location_type=$3 and coalesce(site_name,'')=coalesce($4,'')
          and expiry_date is null and quantity > 0
        order by id`, base)

    const seen = new Set()
    let need = want, drawn = 0
    for (const r of [...exact, ...unknown]) {
      if (need <= 0) break
      if (seen.has(r.id)) continue
      seen.add(r.id)
      const take = Math.min(r.quantity, need)
      if (take <= 0) continue
      await exec('update stock_lot set quantity = quantity - $2, updated_at = now() where id = $1', [r.id, take])
      drawn += take; need -= take
    }
    if (drawn > 0) {
      await exec(
        `delete from stock_lot where facility_id=$1 and commodity_id=$2 and location_type=$3
           and coalesce(site_name,'')=coalesce($4,'') and quantity <= 0`, base)
    }
    return drawn
  }

  // True when a batch's own credit records (intakes + Increase adjustments) carry
  // more than one distinct non-null expiry — the "one true expiry per batch" rule
  // fails, so we must not blindly relabel the whole batch. Mirrors the reconcile
  // script's ambiguity check.
  static async _batchExpiryAmbiguous(exec, { facility_id, commodity_id }, batch) {
    const { rows } = await exec(
      `select count(distinct expiry_date)::int n from (
         select expiry_date from intake_log
           where facility_id=$1 and commodity_id=$2
             and nullif(btrim(coalesce(batch_number,'')),'')=$3 and expiry_date is not null
         union all
         select expiry_date from stock_adjustment_log
           where facility_id=$1 and commodity_id=$2 and adjustment_type='Increase'
             and nullif(btrim(coalesce(batch_number,'')),'')=$3 and expiry_date is not null
       ) c`, [facility_id, commodity_id, batch])
    return (rows[0]?.n || 0) > 1
  }

  // Relabel EVERY lot of (facility, commodity, batch) — any bin, any site, whatever
  // current expiry — onto `toExpiry`, in place: quantity is conserved (units only
  // change their label) and duplicates merge into an existing identical lot. This is
  // the "one true expiry per batch" repair applied at edit time, so a corrected
  // expiry reaches the store and every bin the stock moved to, and it self-heals a
  // ledger a past edit or the seed left out of sync.
  static async _relabelWholeBatch(exec, { facility_id, commodity_id }, batch, toExpiry) {
    const toE = ymd(toExpiry)
    const { rows: lots } = await exec(
      `select id, location_type, site_name, quantity, section from stock_lot
        where facility_id=$1 and commodity_id=$2
          and nullif(btrim(coalesce(batch_number,'')),'')=$3
          and coalesce(expiry_date,'0001-01-01'::date) <> coalesce($4::date,'0001-01-01'::date)
          and quantity > 0`,
      [facility_id, commodity_id, batch, toE])
    for (const lot of lots) {
      const bin = { facility_id, commodity_id, location_type: lot.location_type, site_name: lot.site_name }
      await LotService.credit(exec, bin, { batch, expiry: toE, qty: lot.quantity, section: lot.section })
      await exec('delete from stock_lot where id=$1', [lot.id])
    }
  }

  // Relabel lots carrying the exact (fromBatch, fromExpiry) identity onto
  // (toBatch, toExpiry) in the NON-store bins (the store leg is handled by the
  // caller's _drawForRelabel). Quantity conserved, duplicates merged. Used for batch
  // renumbers and unbatched/ambiguous expiry edits, where we can only touch stock
  // that literally matches the record's old identity. A fully-generic old identity
  // (no batch AND no expiry) is the anonymous unknown pool — unattributable, skipped.
  static async _relabelExactOtherBins(exec, { facility_id, commodity_id }, { fromBatch, fromExpiry, toBatch, toExpiry }) {
    const fromB = fromBatch || null, toB = toBatch || null
    const fromE = ymd(fromExpiry), toE = ymd(toExpiry)
    if (!fromB && !fromE) return
    const { rows: lots } = await exec(
      `select id, location_type, site_name, quantity, section from stock_lot
        where facility_id=$1 and commodity_id=$2 and location_type <> 'store'
          and coalesce(batch_number,'')=coalesce($3,'')
          and coalesce(expiry_date,'0001-01-01'::date)=coalesce($4::date,'0001-01-01'::date)
          and quantity > 0`,
      [facility_id, commodity_id, fromB, fromE])
    for (const lot of lots) {
      const bin = { facility_id, commodity_id, location_type: lot.location_type, site_name: lot.site_name }
      await LotService.credit(exec, bin, { batch: toB, expiry: toE, qty: lot.quantity, section: lot.section })
      await exec('delete from stock_lot where id=$1', [lot.id])
    }
  }

  /**
   * Reconstruct the STORE bin's per-batch ledger straight from the authoritative
   * records, so an activity-log edit's batch / expiry / quantity all surface on Stock
   * Levels — no matter how far the ledger had drifted (a renamed batch, a stale
   * expiry, a pre-fix edit). The store's true composition is:
   *
   *     what the records credited   (intakes + Increase adjustments)
   *   − what the records removed     (Decrease adjustments)
   *   − what now lives in other bins (dispensary / DSD / SDP lots)
   *
   * grouped by (batch, expiry). We rebuild to that ONLY when it reconciles exactly to
   * the store's authoritative SOH (the `stock` aggregate) and no identity goes
   * negative — so it can never invent or drop stock. When it can't reconcile (an
   * untracked outflow, e.g. an old batch-less store dispense), it changes nothing and
   * returns false, leaving the caller's best-effort relabel in place.
   */
  static async _rebuildStoreFromRecords(exec, { facility_id, commodity_id }) {
    const p = [facility_id, commodity_id]
    const { rows: sohRows } = await exec(
      `select quantity from stock where facility_id=$1 and commodity_id=$2 and location_type='store'`, p)
    const soh = sohRows[0]?.quantity || 0

    // Net records by (batch, expiry): credits positive, Decrease adjustments negative.
    const { rows: recs } = await exec(`
      select coalesce(nullif(btrim(coalesce(batch_number,'')),''),'') batch,
             to_char(expiry_date,'YYYY-MM-DD') exp, sum(q)::int qty
        from (
          select batch_number, expiry_date, quantity q from intake_log
            where facility_id=$1 and commodity_id=$2
          union all
          select batch_number, expiry_date, quantity q from stock_adjustment_log
            where facility_id=$1 and commodity_id=$2 and adjustment_type='Increase'
          union all
          select batch_number, expiry_date, -quantity q from stock_adjustment_log
            where facility_id=$1 and commodity_id=$2 and adjustment_type='Decrease'
        ) c group by 1, 2`, p)

    // What currently lives in the non-store bins, by (batch, expiry).
    const { rows: other } = await exec(`
      select coalesce(nullif(btrim(coalesce(batch_number,'')),''),'') batch,
             to_char(expiry_date,'YYYY-MM-DD') exp, sum(quantity)::int qty
        from stock_lot
       where facility_id=$1 and commodity_id=$2 and location_type <> 'store' and quantity > 0
       group by 1, 2`, p)

    // target store = records − other bins, per identity.
    const map = new Map()
    const mkey = (b, e) => `${b}|${e || ''}`
    for (const r of recs)  map.set(mkey(r.batch, r.exp), (map.get(mkey(r.batch, r.exp)) || 0) + r.qty)
    for (const o of other) map.set(mkey(o.batch, o.exp), (map.get(mkey(o.batch, o.exp)) || 0) - o.qty)

    const target = []
    let sum = 0
    for (const [k, qty] of map) {
      if (qty < 0) return false          // other bins hold more of an identity than records credit — inconsistent
      if (qty === 0) continue
      const [batch, exp] = k.split('|')
      target.push({ batch: batch || null, exp: exp || null, qty })
      sum += qty
    }
    if (sum !== soh) return false         // can't reconcile to authoritative SOH — leave the ledger as-is

    // Carry over the section the store lots use (one per commodity) before we drop them.
    const { rows: secRows } = await exec(
      `select distinct section from stock_lot
         where facility_id=$1 and commodity_id=$2 and location_type='store'
           and coalesce(site_name,'')='' and section is not null`, p)
    const section = secRows.length === 1 ? secRows[0].section : null

    await exec(
      `delete from stock_lot where facility_id=$1 and commodity_id=$2
         and location_type='store' and coalesce(site_name,'')=''`, p)
    const bin = { facility_id, commodity_id, location_type: 'store', site_name: null }
    for (const t of target) await LotService.credit(exec, bin, { batch: t.batch, expiry: t.exp, qty: t.qty, section })
    return true
  }

  /**
   * Record a dispense and decrement the matching stock.
   *
   * `dsd_site_name` / `sdp_name` are routing hints (NOT columns — the real
   * dispense_log has neither). When given, the corresponding site stock is
   * decremented and the caller is expected to have encoded the site into
   * `notes` (e.g. "[DSD: name]"), matching the frontend convention. Otherwise
   * the facility store stock is decremented.
   */
  static async recordDispense(dispenseData) {
    const {
      facility_id, commodity_id, quantity, dispensed_by, dispensed_at,
      notes, dsd_site_name, sdp_name, section, location_type,
      batch_number, expiry_date
    } = dispenseData

    // quantity may be 0 (a "nothing consumed today" record), so guard on null/undefined
    // rather than falsiness. A 0 debit is a no-op in the ledger and stock decrement.
    if (!facility_id || !commodity_id || quantity == null || !dispensed_by) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, dispensed_by')
    }

    const qty = parseInt(quantity)

    // Log insert + stock decrement commit (or roll back) together.
    return await withTransaction(async exec => {
      const resolvedSection = await resolveSection(section, commodity_id, exec)
      const { rows } = await exec(
        `insert into dispense_log
           (facility_id, commodity_id, quantity, dispensed_by, dispensed_at, notes, section, batch_number, expiry_date)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning *`,
        [facility_id, commodity_id, qty, dispensed_by,
         dispensed_at || new Date().toISOString(), notes || '', resolvedSection,
         batch_number || null, expiry_date || null]
      )
      const dispenseLog = rows[0] || null

      // Decrement the right stock bucket, and debit the matching lot ledger by the
      // same amount — the batch the user chose first, then FEFO for any remainder.
      //
      // Every branch checks the bin can cover `qty` BEFORE writing. Previously the
      // decrements clamped at 0, so consuming from an empty bin still committed the
      // dispense_log row: the bin ended at 0 while the ledger recorded the full
      // issue, and the gap resurfaced later as a bin-card opening balance. Worse,
      // LotService.debit's self-heal reads the bin AFTER the decrement, so a clamped
      // bin made it mint phantom lots to cover the draw. Rejecting up front (409)
      // rolls back the whole transaction — a refused consumption leaves no row.
      // `covers` false means the bin is short AND enforcement is off: fall back to
      // the old clamped decrement so the user isn't blocked during the transition.
      let bin
      if (dsd_site_name) {
        const dsdStock = await StockService.getDsdStockByFacilitySiteCommodity(facility_id, dsd_site_name, commodity_id, exec)
        const covers = await assertBinCovers(exec, dsdStock?.quantity ?? 0, qty, commodity_id, `DSD site "${dsd_site_name}"`)
        if (dsdStock && qty > 0) {
          await exec(`update dsd_stock set quantity = ${covers ? 'quantity - $2' : 'greatest(0, quantity - $2)'}, updated_at = now() where id = $1`, [dsdStock.id, qty])
        }
        bin = { facility_id, commodity_id, location_type: 'dsd', site_name: dsd_site_name }
      } else if (sdp_name) {
        const sdpStock = await StockService.getSdpStockByFacilitySiteCommodity(facility_id, sdp_name, commodity_id, exec)
        const covers = await assertBinCovers(exec, sdpStock?.quantity ?? 0, qty, commodity_id, `SDP site "${sdp_name}"`)
        if (sdpStock && qty > 0) {
          await exec(`update sdp_stock set quantity = ${covers ? 'quantity - $2' : 'greatest(0, quantity - $2)'}, updated_at = now() where id = $1`, [sdpStock.id, qty])
        }
        bin = { facility_id, commodity_id, location_type: 'sdp', site_name: sdp_name }
      } else {
        // Facility consumption deducts the given location (the frontend dispenses
        // from the dispensary); defaults to store when unspecified.
        const loc = location_type || 'store'
        const label = loc === 'store' ? 'the main store' : 'the dispensary'
        const stock = await StockService.getStockByFacilityAndCommodity(facility_id, commodity_id, loc, exec)
        const covers = await assertBinCovers(exec, stock?.quantity ?? 0, qty, commodity_id, label)
        if (stock && qty > 0) {
          // Strict when the precondition passed — closes the check-then-write race.
          // Re-asserting on a null result turns a lost race into the same 409.
          if (covers) {
            const dec = await StockService.decrementStockStrict(stock.id, qty, exec)
            if (!dec) await assertBinCovers(exec, 0, qty, commodity_id, label)
          } else {
            await StockService.decrementStock(stock.id, qty, exec)
          }
        }
        bin = { facility_id, commodity_id, location_type: loc, site_name: null }
      }
      // Enforce (phase 3): a chosen batch must cover qty and not be expired; with
      // no batch, FEFO skips expired lots. Blocks (409) if eligible stock is short.
      await LotService.debit(exec, bin, qty, { batch: batch_number || null, enforce: true })

      return dispenseLog
    })
  }

  /**
   * Dispense history for a facility, newest first, with nested commodity.
   * Site filtering uses the notes convention ("[DSD: name]" / "[SDP: name]")
   * since dispense_log has no site column.
   */
  static async getDispenseHistory(facilityId, options = {}) {
    const { dsdSiteName, sdpName, date, from, to, facilityIds, commodityIds, categories, section, limit = 1000, offset = 0 } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    applyLogFilters({ conds, params, dateField: 'dispensed_at', facilityId, facilityIds, commodityIds, categories, date, from, to, section })

    if (dsdSiteName) { params.push(`%[DSD: ${dsdSiteName}]%`); conds.push(`l.notes like $${params.length}`) }
    else if (sdpName) { params.push(`%[SDP: ${sdpName}]%`); conds.push(`l.notes like $${params.length}`) }

    let sql = `
      select l.*, ${COMM4_OBJ}, ${FAC_OBJ}
      from dispense_log l
      left join commodities c on c.id = l.commodity_id
      left join facilities f on f.id = l.facility_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`

    params.push(limit, offset)
    sql += ` order by l.dispensed_at desc limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Consumption summed by commodity + UTC month over a facility set and date
   * window — the AMC aggregate. Returns [{ commodity_id, ym, qty }] (a few dozen
   * rows) instead of every dispense row, so admin dashboards don't ship (and the
   * browser doesn't crunch) tens of thousands of rows. Same filters/rows as
   * getDispenseHistory, just pre-aggregated server-side.
   */
  static async getDispenseSummary(facilityId, options = {}) {
    const { from, to, facilityIds, commodityIds, categories, section } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    applyLogFilters({ conds, params, dateField: 'dispensed_at', facilityId, facilityIds, commodityIds, categories, from, to, section })

    // Only join commodities when a category (section) filter needs it.
    const needCommJoin = Array.isArray(categories) && categories.length
    let sql = `
      select l.commodity_id,
             to_char(l.dispensed_at at time zone 'UTC', 'YYYY-MM') as ym,
             sum(l.quantity)::int as qty
      from dispense_log l
      ${needCommJoin ? 'left join commodities c on c.id = l.commodity_id' : ''}`
    if (conds.length) sql += ` where ${conds.join(' and ')}`
    sql += ` group by l.commodity_id, ym`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Record an intake and add to the facility store stock (create if absent).
   */
  static async recordIntake(intakeData) {
    const {
      facility_id, commodity_id, quantity, supplier_source, batch_number,
      expiry_date, delivery_note_ref, condition_on_arrival, received_by,
      received_at, notes, section
    } = intakeData

    if (!facility_id || !commodity_id || !quantity || !received_by) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, received_by')
    }

    const qty = parseInt(quantity)

    // Log insert + stock increment commit (or roll back) together.
    return await withTransaction(async exec => {
      const resolvedSection = await resolveSection(section, commodity_id, exec)
      const { rows } = await exec(
        `insert into intake_log
           (facility_id, commodity_id, quantity, supplier_source, batch_number, expiry_date,
            delivery_note_ref, condition_on_arrival, received_by, received_at, notes, section)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning *`,
        [facility_id, commodity_id, qty, supplier_source || '', batch_number || '',
         expiry_date || null, delivery_note_ref || '', condition_on_arrival || 'Good',
         received_by, received_at || new Date().toISOString(), notes || '', resolvedSection]
      )
      const intakeLog = rows[0] || null

      const existing = await StockService.getStockByFacilityAndCommodity(facility_id, commodity_id, 'store', exec)
      if (existing) {
        await StockService.incrementStock(existing.id, qty, exec)
      } else {
        await StockService.createStock({ facility_id, commodity_id, quantity: qty, location_type: 'store' }, exec)
      }
      // An intake is a new store lot with its recorded batch/expiry.
      await LotService.credit(exec, { facility_id, commodity_id, location_type: 'store', site_name: null },
        { batch: batch_number || null, expiry: expiry_date || null, qty, section: resolvedSection })

      return intakeLog
    })
  }

  /**
   * Intake history for a facility, newest first, with nested commodity.
   */
  static async getIntakeHistory(facilityId, options = {}) {
    const {
      date, from, to, supplier_source, facilityIds, commodityIds, categories, section,
      expiryFrom, expiryTo, hasQuantity, limit = 1000, offset = 0
    } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    applyLogFilters({ conds, params, dateField: 'received_at', facilityId, facilityIds, commodityIds, categories, date, from, to, section })

    if (supplier_source) { params.push(supplier_source); conds.push(`l.supplier_source = $${params.length}`) }
    // Expiry-tracking filters (Monitoring expiry tab): a non-null expiry_date in
    // range, with remaining stock. The >= comparison already excludes NULLs.
    if (expiryFrom) { params.push(expiryFrom); conds.push(`l.expiry_date >= $${params.length}`) }
    if (expiryTo) { params.push(expiryTo); conds.push(`l.expiry_date <= $${params.length}`) }
    if (hasQuantity) { conds.push(`l.quantity > 0`) }

    let sql = `
      select l.*, ${COMM4_OBJ}, ${FAC_OBJ}
      from intake_log l
      left join commodities c on c.id = l.commodity_id
      left join facilities f on f.id = l.facility_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`

    params.push(limit, offset)
    sql += ` order by l.received_at desc limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Commodity ids this facility (or scope) has EVER transacted — any intake or
   * dispense record, however old. Used to tell a real stockout from a commodity
   * the facility simply never handles: current stock and the AMC window both miss
   * something last touched long ago. Ids only, so it stays cheap.
   */
  static async getTransactedCommodityIds(facilityId, { facilityIds } = {}) {
    const params = []
    let cond = 'true'
    if (facilityId) {
      params.push(facilityId); cond = `facility_id = $${params.length}`
    } else if (Array.isArray(facilityIds)) {
      if (!facilityIds.length) return []
      params.push(facilityIds); cond = `facility_id = any($${params.length})`
    }
    // Filter inside each branch so the facility_id index is used, then union
    // (which de-duplicates) rather than scanning a combined set.
    const { rows } = await query(
      `select commodity_id from intake_log   where ${cond} and commodity_id is not null
       union
       select commodity_id from dispense_log where ${cond} and commodity_id is not null`,
      params
    )
    return rows.map(r => r.commodity_id)
  }

  /**
   * Record a stock adjustment and apply it to the facility store stock.
   */
  static async recordAdjustment(adjustmentData) {
    const {
      facility_id, commodity_id, quantity, adjustment_type, reason, adjusted_by,
      reference_number, notes, adjusted_at, expiry_date, batch_number, section
    } = adjustmentData

    if (!facility_id || !commodity_id || !quantity || !adjustment_type || !reason || !adjusted_by) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, adjustment_type, reason, adjusted_by')
    }
    if (!['Increase', 'Decrease'].includes(adjustment_type)) {
      throw new Error('adjustment_type must be "Increase" or "Decrease"')
    }

    const qty = parseInt(quantity)

    // Log insert + stock adjustment commit (or roll back) together.
    return await withTransaction(async exec => {
      const resolvedSection = await resolveSection(section, commodity_id, exec)
      const { rows } = await exec(
        `insert into stock_adjustment_log
           (facility_id, commodity_id, quantity, adjustment_type, reason, adjusted_by,
            reference_number, notes, adjusted_at, expiry_date, batch_number, section)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning *`,
        [facility_id, commodity_id, qty, adjustment_type, reason, adjusted_by,
         reference_number || '', notes || '', adjusted_at || new Date().toISOString(),
         expiry_date || null, batch_number || '', resolvedSection]
      )
      const adjustmentLog = rows[0] || null

      const bin = { facility_id, commodity_id, location_type: 'store', site_name: null }
      const stock = await StockService.getStockByFacilityAndCommodity(facility_id, commodity_id, 'store', exec)
      if (stock) {
        if (adjustment_type === 'Increase') await StockService.incrementStock(stock.id, qty, exec)
        else await StockService.decrementStock(stock.id, qty, exec)
      } else if (adjustment_type === 'Increase') {
        await StockService.createStock({ facility_id, commodity_id, quantity: qty, location_type: 'store' }, exec)
      }
      // Mirror the store change on the lot ledger: an increase is a lot with its
      // recorded batch/expiry; a decrease draws FEFO (soonest-expiry first).
      if (adjustment_type === 'Increase') {
        await LotService.credit(exec, bin, { batch: batch_number || null, expiry: expiry_date || null, qty, section: resolvedSection })
      } else {
        await LotService.debit(exec, bin, qty, { batch: batch_number || null })
      }

      return adjustmentLog
    })
  }

  /**
   * Adjustment history for a facility, newest first, with nested commodity.
   */
  static async getAdjustmentHistory(facilityId, options = {}) {
    const { date, from, to, adjustment_type, reason, facilityIds, commodityIds, categories, section, limit = 1000, offset = 0 } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    applyLogFilters({ conds, params, dateField: 'adjusted_at', facilityId, facilityIds, commodityIds, categories, date, from, to, section })

    if (adjustment_type) { params.push(adjustment_type); conds.push(`l.adjustment_type = $${params.length}`) }
    if (reason) { params.push(reason); conds.push(`l.reason = $${params.length}`) }

    let sql = `
      select l.*, ${COMM4_OBJ}, ${FAC_OBJ}
      from stock_adjustment_log l
      left join commodities c on c.id = l.commodity_id
      left join facilities f on f.id = l.facility_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`

    params.push(limit, offset)
    sql += ` order by l.adjusted_at desc limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Stock count history for a facility, newest first. Exposes counted vs system vs
   * variance — the audit trail the retired adjustment-only flow could never give,
   * because it kept the delta and discarded the counted figure.
   */
  static async getStockCountHistory(facilityId, { commodityId = null, limit = 100 } = {}) {
    const params = [facilityId]
    let sql = `
      select sc.*, c.name commodity_name, c.unit commodity_unit
        from stock_count sc
        left join commodities c on c.id = sc.commodity_id
       where sc.facility_id = $1`
    if (commodityId) { params.push(commodityId); sql += ` and sc.commodity_id = $${params.length}` }
    params.push(limit)
    sql += ` order by sc.counted_at desc limit $${params.length}`
    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Record a physical stock count and reconcile the bin to it.
   *
   * The count is the FACT (what was on the shelf); the adjustment is DERIVED from
   * it. Callers send `counted_quantity` — never a delta. This is the one operation
   * allowed to set stock directly, because it is backed by physical observation.
   *
   * Idempotent by construction: `system_quantity` is read server-side at count time,
   * so counting 200 twice gives variance 0 the second time. That is what makes the
   * repeated-stock-take failure (Apapa: -1766/-1746/-1723 for one shelf) impossible.
   *
   * Whole-bin only — lots are reconciled FEFO to the counted total.
   * Everything commits together, so a count never half-applies.
   */
  static async recordStockCount(countData) {
    const {
      facility_id, commodity_id, location_type = 'store', site_name = null,
      counted_quantity, counted_by, counted_at, notes, section
    } = countData

    if (!facility_id || !commodity_id || counted_quantity == null || !counted_by) {
      throw new Error('Missing required fields: facility_id, commodity_id, counted_quantity, counted_by')
    }
    if (!['store', 'dispensary', 'dsd', 'sdp'].includes(location_type)) {
      throw new Error("location_type must be one of 'store', 'dispensary', 'dsd', 'sdp'")
    }
    if ((location_type === 'dsd' || location_type === 'sdp') && !site_name) {
      throw new Error('site_name is required when counting a DSD/SDP bin')
    }
    const counted = parseInt(counted_quantity)
    if (!Number.isFinite(counted) || counted < 0) throw new Error('counted_quantity must be 0 or more')

    return await withTransaction(async exec => {
      const resolvedSection = await resolveSection(section, commodity_id, exec)
      const bin = { facility_id, commodity_id, location_type, site_name: site_name || null }
      const countedAt = counted_at || new Date().toISOString()

      // The books, read inside the transaction so nothing can move underneath us.
      const systemQty = await binStockOnHand(exec, bin)
      const variance = counted - systemQty

      const { rows: countRows } = await exec(
        `insert into stock_count
           (facility_id, commodity_id, location_type, site_name, counted_quantity,
            system_quantity, counted_by, counted_at, notes, section)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning *`,
        [facility_id, commodity_id, location_type, site_name || null, counted,
         systemQty, counted_by, countedAt, notes || '', resolvedSection]
      )
      const stockCount = countRows[0]

      // Books already agree with the shelf — record the count, post nothing.
      if (variance === 0) return stockCount

      // Derive the adjustment so the movement ledger stays the single source of
      // movements and the bin card needs no special case for counts.
      const { rows: adjRows } = await exec(
        `insert into stock_adjustment_log
           (facility_id, commodity_id, quantity, adjustment_type, reason, adjusted_by,
            reference_number, notes, adjusted_at, section)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning *`,
        [facility_id, commodity_id, Math.abs(variance),
         variance > 0 ? 'Increase' : 'Decrease', STOCK_COUNT_REASON, counted_by,
         '', `Physical count ${counted} vs system ${systemQty}${notes ? ` — ${notes}` : ''}`,
         countedAt, resolvedSection]
      )
      await exec('update stock_count set adjustment_id = $2 where id = $1', [stockCount.id, adjRows[0].id])

      // Set the bin to the counted figure — assignment, not a delta, so the shelf
      // wins outright and a repeated count cannot compound.
      await setBinStockOnHand(exec, bin, counted)
      // Bring the lot ledger to the same total: trim FEFO / top up unknown-expiry.
      await LotService.reconcile(exec, bin)

      return { ...stockCount, adjustment_id: adjRows[0].id, variance }
    })
  }
}
