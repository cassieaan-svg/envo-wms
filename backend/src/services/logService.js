import { query, withTransaction } from '../db.js'
import { StockService } from './stockService.js'

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

// Shared facility/commodity/date-range/section filters for the log history
// queries. Mutates `conds`/`params` in place (params is 1-based for $n). Covers
// both the per-facility per-day "recent entries" view and the multi-facility
// date-range report aggregation.
//   facilityId  — single facility (when the route pinned one)
//   facilityIds — array of facilities (scoped/admin multi-facility); [] = none
//   commodityIds, section, date (single day), from/to (range on dateField)
function applyLogFilters({ conds, params, dateField, facilityId, facilityIds, commodityIds, date, from, to, section }) {
  if (facilityId) { params.push(facilityId); conds.push(`l.facility_id = $${params.length}`) }
  else if (Array.isArray(facilityIds)) { params.push(facilityIds); conds.push(`l.facility_id = any($${params.length})`) }

  if (Array.isArray(commodityIds) && commodityIds.length) { params.push(commodityIds); conds.push(`l.commodity_id = any($${params.length})`) }
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
  intake:     ['quantity', 'expiry_date', 'supplier_source', 'condition_on_arrival', 'edited_by'],
  adjustment: ['quantity', 'reason', 'notes', 'edited_by'],
}

export class LogService {
  /** Fetch one log row by type + id (for edit scoping/existence). Null if absent. */
  static async getLogRow(type, id) {
    const table = LOG_TABLES[type]
    if (!table) throw new Error(`Unknown log type: ${type}`)
    const { rows } = await query(`select * from ${table} where id = $1`, [id])
    return rows[0] || null
  }

  /** Metadata-only update of a log row (no stock side-effects). Whitelisted fields. */
  static async updateLog(type, id, fields = {}) {
    const table = LOG_TABLES[type]
    const allowed = LOG_EDIT_FIELDS[type]
    if (!table) throw new Error(`Unknown log type: ${type}`)

    const sets = []
    const params = [id]
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        params.push(k === 'quantity' ? parseInt(fields[k]) : fields[k])
        sets.push(`${k} = $${params.length}`)
      }
    }
    if (!sets.length) throw new Error('No updatable fields provided')

    const { rows } = await query(`update ${table} set ${sets.join(', ')} where id = $1 returning *`, params)
    return rows[0] || null
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
      notes, dsd_site_name, sdp_name, section, location_type
    } = dispenseData

    if (!facility_id || !commodity_id || !quantity || !dispensed_by) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, dispensed_by')
    }

    const qty = parseInt(quantity)

    // Log insert + stock decrement commit (or roll back) together.
    return await withTransaction(async exec => {
      const { rows } = await exec(
        `insert into dispense_log
           (facility_id, commodity_id, quantity, dispensed_by, dispensed_at, notes, section)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *`,
        [facility_id, commodity_id, qty, dispensed_by,
         dispensed_at || new Date().toISOString(), notes || '', section || null]
      )
      const dispenseLog = rows[0] || null

      // Decrement the right stock bucket.
      if (dsd_site_name) {
        const dsdStock = await StockService.getDsdStockByFacilitySiteCommodity(facility_id, dsd_site_name, commodity_id, exec)
        if (dsdStock) {
          await exec('update dsd_stock set quantity = greatest(0, quantity - $2), updated_at = now() where id = $1', [dsdStock.id, qty])
        }
      } else if (sdp_name) {
        const sdpStock = await StockService.getSdpStockByFacilitySiteCommodity(facility_id, sdp_name, commodity_id, exec)
        if (sdpStock) {
          await exec('update sdp_stock set quantity = greatest(0, quantity - $2), updated_at = now() where id = $1', [sdpStock.id, qty])
        }
      } else {
        // Facility consumption deducts the given location (the frontend dispenses
        // from the dispensary); defaults to store when unspecified.
        const loc = location_type || 'store'
        const stock = await StockService.getStockByFacilityAndCommodity(facility_id, commodity_id, loc, exec)
        if (stock) await StockService.decrementStock(stock.id, qty, exec)
      }

      return dispenseLog
    })
  }

  /**
   * Dispense history for a facility, newest first, with nested commodity.
   * Site filtering uses the notes convention ("[DSD: name]" / "[SDP: name]")
   * since dispense_log has no site column.
   */
  static async getDispenseHistory(facilityId, options = {}) {
    const { dsdSiteName, sdpName, date, from, to, facilityIds, commodityIds, section, limit = 1000, offset = 0 } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    applyLogFilters({ conds, params, dateField: 'dispensed_at', facilityId, facilityIds, commodityIds, date, from, to, section })

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
      const { rows } = await exec(
        `insert into intake_log
           (facility_id, commodity_id, quantity, supplier_source, batch_number, expiry_date,
            delivery_note_ref, condition_on_arrival, received_by, received_at, notes, section)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning *`,
        [facility_id, commodity_id, qty, supplier_source || '', batch_number || '',
         expiry_date || null, delivery_note_ref || '', condition_on_arrival || 'Good',
         received_by, received_at || new Date().toISOString(), notes || '', section || null]
      )
      const intakeLog = rows[0] || null

      const existing = await StockService.getStockByFacilityAndCommodity(facility_id, commodity_id, 'store', exec)
      if (existing) {
        await StockService.incrementStock(existing.id, qty, exec)
      } else {
        await StockService.createStock({ facility_id, commodity_id, quantity: qty, location_type: 'store' }, exec)
      }

      return intakeLog
    })
  }

  /**
   * Intake history for a facility, newest first, with nested commodity.
   */
  static async getIntakeHistory(facilityId, options = {}) {
    const {
      date, from, to, supplier_source, facilityIds, commodityIds, section,
      expiryFrom, expiryTo, hasQuantity, limit = 1000, offset = 0
    } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    applyLogFilters({ conds, params, dateField: 'received_at', facilityId, facilityIds, commodityIds, date, from, to, section })

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
      const { rows } = await exec(
        `insert into stock_adjustment_log
           (facility_id, commodity_id, quantity, adjustment_type, reason, adjusted_by,
            reference_number, notes, adjusted_at, expiry_date, batch_number, section)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning *`,
        [facility_id, commodity_id, qty, adjustment_type, reason, adjusted_by,
         reference_number || '', notes || '', adjusted_at || new Date().toISOString(),
         expiry_date || null, batch_number || '', section || null]
      )
      const adjustmentLog = rows[0] || null

      const stock = await StockService.getStockByFacilityAndCommodity(facility_id, commodity_id, 'store', exec)
      if (stock) {
        if (adjustment_type === 'Increase') await StockService.incrementStock(stock.id, qty, exec)
        else await StockService.decrementStock(stock.id, qty, exec)
      } else if (adjustment_type === 'Increase') {
        await StockService.createStock({ facility_id, commodity_id, quantity: qty, location_type: 'store' }, exec)
      }

      return adjustmentLog
    })
  }

  /**
   * Adjustment history for a facility, newest first, with nested commodity.
   */
  static async getAdjustmentHistory(facilityId, options = {}) {
    const { date, from, to, adjustment_type, reason, facilityIds, commodityIds, section, limit = 1000, offset = 0 } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    applyLogFilters({ conds, params, dateField: 'adjusted_at', facilityId, facilityIds, commodityIds, date, from, to, section })

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
