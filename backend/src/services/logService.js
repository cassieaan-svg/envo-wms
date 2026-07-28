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
        const bin = { facility_id: old.facility_id, commodity_id: old.commodity_id, location_type: 'store', site_name: null }
        await this._syncStoreLotOnEdit(exec, bin, {
          oldBatch: old.batch_number,   oldExpiry: old.expiry_date, oldQty: old.quantity,
          newBatch: updated.batch_number, newExpiry: updated.expiry_date, newQty: updated.quantity,
        })
        // The corrected stock may have already moved on to the dispensary/DSD/SDP
        // bins, which still carry the OLD (batch, expiry). Relabel those too so a
        // wrong-expiry fix reaches every bin the stock reached, not just the store.
        await this._syncOtherBinsOnEdit(exec,
          { facility_id: old.facility_id, commodity_id: old.commodity_id }, {
            oldBatch: old.batch_number,   oldExpiry: old.expiry_date,
            newBatch: updated.batch_number, newExpiry: updated.expiry_date,
          })
      }
      return updated
    })
  }

  /**
   * Mirror an intake/Increase-adjustment edit onto the STORE lot ledger. The
   * record contributed `oldQty` units to the bin; we (1) relabel that on-hand
   * portion onto the corrected (newBatch, newExpiry), and (2) apply the quantity
   * delta on the corrected identity. The units are drawn from where the record's
   * stock actually lives — the exact old-identity lot first, then the bin's
   * UNKNOWN-expiry lots (where the migration seeded historical stock that never
   * carried a batch/expiry) — always clamped to what's on hand so stock that has
   * since been dispensed or moved is never over-debited. The aggregate `stock`
   * total is reconciled separately by the client; this keeps the per-batch ledger
   * (the Monitoring / expiry views) honest.
   */
  static async _syncStoreLotOnEdit(exec, bin, { oldBatch, oldExpiry, oldQty, newBatch, newExpiry, newQty }) {
    const oldB = oldBatch || null, newB = newBatch || null
    const oldE = ymd(oldExpiry), newE = ymd(newExpiry)
    const oQ = Math.max(0, Math.round(Number(oldQty)) || 0)
    const nQ = Math.max(0, Math.round(Number(newQty)) || 0)
    const identityChanged = (oldB || '') !== (newB || '') || (oldE || '') !== (newE || '')

    if (identityChanged && oQ > 0) {
      const moved = await this._drawForRelabel(exec, bin, { batch: oldB, expiry: oldE }, oQ)
      if (moved > 0) await LotService.credit(exec, bin, { batch: newB, expiry: newE, qty: moved })
    }

    // Track the quantity change on the corrected identity: grow it, or trim it
    // (drawing only from this batch, clamped to what's on hand — never negative).
    const delta = nQ - oQ
    if (delta > 0) await LotService.credit(exec, bin, { batch: newB, expiry: newE, qty: delta })
    else if (delta < 0) await LotService.debit(exec, bin, -delta, { batch: newB })
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

  /**
   * Propagate an intake/Increase-adjustment expiry (or batch) correction to the
   * NON-store bins — dispensary, DSD, SDP — that this stock has since moved into.
   * When stock leaves the store it carries its (batch, expiry) verbatim, so a lot
   * elsewhere still labelled with the OLD identity is now stale. A batch has exactly
   * one true expiry, so we relabel every such lot onto the corrected identity in
   * place: same bin, quantity unchanged (units only change their label), merging into
   * an identical existing lot if one is already there. This keeps the Monitoring /
   * expiry views honest across all bins, not just the store.
   *
   * Guards (mirroring the reconcile script's Pass 1, so we never over-reach):
   *  - Skip if nothing about the identity changed.
   *  - Skip a fully generic old identity (no old batch AND no old expiry): that maps
   *    to the anonymous unknown pool, which can't be attributed to this record.
   *  - Skip an AMBIGUOUS batch — one whose own credit records disagree on the expiry
   *    (more than one distinct value) — leaving it for a human / the reconcile script.
   */
  static async _syncOtherBinsOnEdit(exec, { facility_id, commodity_id }, { oldBatch, oldExpiry, newBatch, newExpiry }) {
    const oldB = oldBatch || null, newB = newBatch || null
    const oldE = ymd(oldExpiry), newE = ymd(newExpiry)
    if ((oldB || '') === (newB || '') && (oldE || '') === (newE || '')) return  // no identity change
    if (!oldB && !oldE) return                                                  // generic unknown pool — unattributable

    // Ambiguity guard: if the corrected batch's own credit records carry more than
    // one distinct non-null expiry, the "one true expiry" assumption fails — bail.
    if (newB) {
      const { rows } = await exec(
        `select count(distinct expiry_date)::int n from (
           select expiry_date from intake_log
             where facility_id=$1 and commodity_id=$2
               and nullif(btrim(coalesce(batch_number,'')),'')=$3 and expiry_date is not null
           union all
           select expiry_date from stock_adjustment_log
             where facility_id=$1 and commodity_id=$2 and adjustment_type='Increase'
               and nullif(btrim(coalesce(batch_number,'')),'')=$3 and expiry_date is not null
         ) c`, [facility_id, commodity_id, newB])
      if ((rows[0]?.n || 0) > 1) return
    }

    // Every non-store lot still carrying the old identity is stale — relabel in place.
    const { rows: lots } = await exec(
      `select id, location_type, site_name, quantity, section from stock_lot
        where facility_id=$1 and commodity_id=$2 and location_type <> 'store'
          and coalesce(batch_number,'')=coalesce($3,'')
          and coalesce(expiry_date,'0001-01-01'::date)=coalesce($4::date,'0001-01-01'::date)
          and quantity > 0`,
      [facility_id, commodity_id, oldB, oldE])
    for (const lot of lots) {
      const bin = { facility_id, commodity_id, location_type: lot.location_type, site_name: lot.site_name }
      await LotService.credit(exec, bin, { batch: newB, expiry: newE, qty: lot.quantity, section: lot.section })
      await exec('delete from stock_lot where id=$1', [lot.id])
    }
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

    if (!facility_id || !commodity_id || !quantity || !dispensed_by) {
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
      let bin
      if (dsd_site_name) {
        const dsdStock = await StockService.getDsdStockByFacilitySiteCommodity(facility_id, dsd_site_name, commodity_id, exec)
        if (dsdStock) {
          await exec('update dsd_stock set quantity = greatest(0, quantity - $2), updated_at = now() where id = $1', [dsdStock.id, qty])
        }
        bin = { facility_id, commodity_id, location_type: 'dsd', site_name: dsd_site_name }
      } else if (sdp_name) {
        const sdpStock = await StockService.getSdpStockByFacilitySiteCommodity(facility_id, sdp_name, commodity_id, exec)
        if (sdpStock) {
          await exec('update sdp_stock set quantity = greatest(0, quantity - $2), updated_at = now() where id = $1', [sdpStock.id, qty])
        }
        bin = { facility_id, commodity_id, location_type: 'sdp', site_name: sdp_name }
      } else {
        // Facility consumption deducts the given location (the frontend dispenses
        // from the dispensary); defaults to store when unspecified.
        const loc = location_type || 'store'
        const stock = await StockService.getStockByFacilityAndCommodity(facility_id, commodity_id, loc, exec)
        if (stock) await StockService.decrementStock(stock.id, qty, exec)
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
}
