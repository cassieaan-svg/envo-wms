import { query } from '../db.js'

// Embedded-object SQL fragments. The frontend (and the other services) expect
// stock rows to carry nested `facilities` / `commodities` objects, the same
// shape Supabase's PostgREST embedded selects produced. We rebuild those with
// json_build_object so callers don't have to change.
const COMMODITY_OBJ = `
  json_build_object(
    'id', c.id, 'name', c.name, 'category', c.category,
    'unit', c.unit, 'dispensing_unit', c.dispensing_unit, 'pack_size', c.pack_size
  ) as commodities`

const FACILITY_OBJ = `
  json_build_object('id', f.id, 'name', f.name, 'state', f.state, 'lga', f.lga) as facilities`

export class StockService {
  /**
   * Get stock records for a facility (store + dispensary), with nested
   * facility/commodity details, ordered by commodity name.
   */
  static async getStock(facilityId, options = {}) {
    const { commodityId, locationType, categories = null, limit = 1000, offset = 0 } = options

    const params = [facilityId]
    let sql = `
      select s.id, s.facility_id, s.commodity_id, s.quantity, s.tablet_buffer,
             s.baseline_amc, s.updated_at, s.location_type,
             ${FACILITY_OBJ}, ${COMMODITY_OBJ}
      from stock s
      left join facilities f on f.id = s.facility_id
      left join commodities c on c.id = s.commodity_id
      where s.facility_id = $1`

    if (commodityId) { params.push(commodityId); sql += ` and s.commodity_id = $${params.length}` }
    if (locationType) { params.push(locationType); sql += ` and s.location_type = $${params.length}` }
    // Section enforcement: restrict to the caller's commodity categories.
    if (Array.isArray(categories) && categories.length) { params.push(categories); sql += ` and c.category = any($${params.length})` }

    params.push(limit, offset)
    sql += ` order by c.name nulls last limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Get stock across a set of facilities (admin/multi-facility view). `facilityIds`
   * null = all facilities (unconstrained — overall/cluster admin); an array = only
   * those facilities; an empty array short-circuits to no rows. Optional
   * `commodityIds` narrows to a commodity-section subset. Paginated via limit/offset.
   * Same row shape as getStock (nested facilities/commodities).
   */
  static async getScopedStock({ facilityIds = null, commodityIds = null, categories = null, limit = 1000, offset = 0 } = {}) {
    if (Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    if (Array.isArray(facilityIds)) { params.push(facilityIds); conds.push(`s.facility_id = any($${params.length})`) }
    if (Array.isArray(commodityIds) && commodityIds.length) { params.push(commodityIds); conds.push(`s.commodity_id = any($${params.length})`) }
    if (Array.isArray(categories) && categories.length) { params.push(categories); conds.push(`c.category = any($${params.length})`) }

    let sql = `
      select s.id, s.facility_id, s.commodity_id, s.quantity, s.tablet_buffer,
             s.baseline_amc, s.updated_at, s.location_type,
             ${FACILITY_OBJ}, ${COMMODITY_OBJ}
      from stock s
      left join facilities f on f.id = s.facility_id
      left join commodities c on c.id = s.commodity_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`

    params.push(limit, offset)
    sql += ` order by c.name nulls last limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Get DSD stock for one facility (`facilityId`) or a set (`facilityIds`, for
   * admin/aggregate views), optionally a single site or commodity. Embeds both
   * commodity and facility objects (SiteBreakdownModal reads facilities.name).
   */
  static async getDsdStock(facilityId, options = {}) {
    const { dsdSiteName, commodityId, facilityIds, categories = null, limit = 1000, offset = 0 } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    if (facilityId) { params.push(facilityId); conds.push(`d.facility_id = $${params.length}`) }
    else if (Array.isArray(facilityIds)) { params.push(facilityIds); conds.push(`d.facility_id = any($${params.length})`) }
    // Site names can drift in case/whitespace between the store dispatch and the
    // DSD account (e.g. "VINZORB Pharmacy" vs "Vinzorb Pharmacy"), so match loosely.
    if (dsdSiteName) { params.push(dsdSiteName); conds.push(`lower(btrim(d.dsd_site_name)) = lower(btrim($${params.length}))`) }
    if (commodityId) { params.push(commodityId); conds.push(`d.commodity_id = $${params.length}`) }
    if (Array.isArray(categories) && categories.length) { params.push(categories); conds.push(`c.category = any($${params.length})`) }

    let sql = `
      select d.id, d.facility_id, d.dsd_site_name, d.commodity_id, d.quantity, d.updated_at,
             ${COMMODITY_OBJ}, ${FACILITY_OBJ}
      from dsd_stock d
      left join commodities c on c.id = d.commodity_id
      left join facilities f on f.id = d.facility_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`

    params.push(limit, offset)
    sql += ` order by c.name nulls last limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Get SDP stock for one facility (`facilityId`) or a set (`facilityIds`),
   * optionally a single site or commodity. Embeds commodity + facility objects.
   */
  static async getSdpStock(facilityId, options = {}) {
    const { sdpName, commodityId, facilityIds, categories = null, limit = 1000, offset = 0 } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    if (facilityId) { params.push(facilityId); conds.push(`sp.facility_id = $${params.length}`) }
    else if (Array.isArray(facilityIds)) { params.push(facilityIds); conds.push(`sp.facility_id = any($${params.length})`) }
    // Match loosely on case/whitespace so a differently-cased site name still resolves.
    if (sdpName) { params.push(sdpName); conds.push(`lower(btrim(sp.sdp_name)) = lower(btrim($${params.length}))`) }
    if (commodityId) { params.push(commodityId); conds.push(`sp.commodity_id = $${params.length}`) }
    if (Array.isArray(categories) && categories.length) { params.push(categories); conds.push(`c.category = any($${params.length})`) }

    let sql = `
      select sp.id, sp.facility_id, sp.sdp_name, sp.commodity_id, sp.quantity, sp.updated_at,
             ${COMMODITY_OBJ}, ${FACILITY_OBJ}
      from sdp_stock sp
      left join commodities c on c.id = sp.commodity_id
      left join facilities f on f.id = sp.facility_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`

    params.push(limit, offset)
    sql += ` order by c.name nulls last limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Create a new stock record.
   */
  static async createStock(stockData, exec = query) {
    const { facility_id, commodity_id, quantity, location_type } = stockData

    if (!facility_id || !commodity_id || quantity === undefined || !location_type) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, location_type')
    }

    const { rows } = await exec(
      `insert into stock (facility_id, commodity_id, quantity, location_type, updated_at)
       values ($1, $2, $3, $4, now())
       returning *`,
      [facility_id, commodity_id, parseInt(quantity), location_type]
    )
    return rows[0] || null
  }

  /**
   * Update stock quantity (absolute set).
   */
  static async updateStock(stockId, updateData) {
    const { quantity } = updateData
    if (quantity === undefined) throw new Error('Missing required field: quantity')

    const { rows } = await query(
      `update stock set quantity = $2, updated_at = now() where id = $1 returning *`,
      [stockId, parseInt(quantity)]
    )
    return rows[0] || null
  }

  /**
   * Upsert store/dispensary stock by its natural key
   * (facility_id, commodity_id, location_type), setting an absolute quantity.
   * Mirrors the frontend's find-then-insert/update pattern in one atomic
   * statement via the unique constraint on those three columns.
   */
  static async upsertStock(stockData, exec = query) {
    const { facility_id, commodity_id, location_type, quantity } = stockData
    if (!facility_id || !commodity_id || !location_type || quantity === undefined) {
      throw new Error('Missing required fields: facility_id, commodity_id, location_type, quantity')
    }
    const { rows } = await exec(
      `insert into stock (facility_id, commodity_id, location_type, quantity, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (facility_id, commodity_id, location_type)
       do update set quantity = excluded.quantity, updated_at = now()
       returning *`,
      [facility_id, commodity_id, location_type, parseInt(quantity)]
    )
    return rows[0] || null
  }

  /**
   * Upsert DSD site stock by (facility_id, dsd_site_name, commodity_id).
   */
  static async upsertDsdStock(stockData, exec = query) {
    const { facility_id, dsd_site_name, commodity_id, quantity } = stockData
    if (!facility_id || !dsd_site_name || !commodity_id || quantity === undefined) {
      throw new Error('Missing required fields: facility_id, dsd_site_name, commodity_id, quantity')
    }
    // Update an existing row for this site even if its casing/whitespace differs,
    // so a re-cased dispatch doesn't fork the site into a duplicate partition.
    const existing = await StockService.getDsdStockByFacilitySiteCommodity(facility_id, dsd_site_name, commodity_id, exec)
    if (existing) return await StockService.updateDsdStock(existing.id, quantity, exec)
    const { rows } = await exec(
      `insert into dsd_stock (facility_id, dsd_site_name, commodity_id, quantity, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (facility_id, dsd_site_name, commodity_id)
       do update set quantity = excluded.quantity, updated_at = now()
       returning *`,
      [facility_id, dsd_site_name, commodity_id, parseInt(quantity)]
    )
    return rows[0] || null
  }

  /**
   * Upsert SDP site stock by (facility_id, sdp_name, commodity_id).
   */
  static async upsertSdpStock(stockData, exec = query) {
    const { facility_id, sdp_name, commodity_id, quantity } = stockData
    if (!facility_id || !sdp_name || !commodity_id || quantity === undefined) {
      throw new Error('Missing required fields: facility_id, sdp_name, commodity_id, quantity')
    }
    // Update an existing row for this site even if its casing/whitespace differs,
    // so a re-cased dispatch doesn't fork the site into a duplicate partition.
    const existing = await StockService.getSdpStockByFacilitySiteCommodity(facility_id, sdp_name, commodity_id, exec)
    if (existing) return await StockService.updateSdpStock(existing.id, quantity, exec)
    const { rows } = await exec(
      `insert into sdp_stock (facility_id, sdp_name, commodity_id, quantity, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (facility_id, sdp_name, commodity_id)
       do update set quantity = excluded.quantity, updated_at = now()
       returning *`,
      [facility_id, sdp_name, commodity_id, parseInt(quantity)]
    )
    return rows[0] || null
  }

  /**
   * Set DSD site stock quantity (absolute) by row id. Returns null if not found.
   */
  static async updateDsdStock(id, quantity, exec = query) {
    if (quantity === undefined) throw new Error('Missing required field: quantity')
    const { rows } = await exec(
      `update dsd_stock set quantity = $2, updated_at = now() where id = $1 returning *`,
      [id, parseInt(quantity)]
    )
    return rows[0] || null
  }

  /**
   * Set SDP site stock quantity (absolute) by row id. Returns null if not found.
   */
  static async updateSdpStock(id, quantity, exec = query) {
    if (quantity === undefined) throw new Error('Missing required field: quantity')
    const { rows } = await exec(
      `update sdp_stock set quantity = $2, updated_at = now() where id = $1 returning *`,
      [id, parseInt(quantity)]
    )
    return rows[0] || null
  }

  /**
   * Get stock record by ID with nested facility/commodity details.
   */
  static async getStockById(stockId) {
    const { rows } = await query(
      `select s.id, s.facility_id, s.commodity_id, s.quantity, s.tablet_buffer,
              s.baseline_amc, s.updated_at, s.location_type,
              json_build_object('id', f.id, 'name', f.name) as facilities,
              json_build_object('id', c.id, 'name', c.name, 'category', c.category, 'unit', c.unit) as commodities
       from stock s
       left join facilities f on f.id = s.facility_id
       left join commodities c on c.id = s.commodity_id
       where s.id = $1`,
      [stockId]
    )
    return rows[0] || null
  }

  /**
   * Get stock by facility + commodity (defaults to the store location).
   * Returns null when not found.
   */
  static async getStockByFacilityAndCommodity(facilityId, commodityId, locationType = 'store', exec = query) {
    const { rows } = await exec(
      `select * from stock
       where facility_id = $1 and commodity_id = $2 and location_type = $3
       limit 1`,
      [facilityId, commodityId, locationType]
    )
    return rows[0] || null
  }

  /**
   * Get DSD stock by facility + site + commodity. Returns null when not found.
   */
  static async getDsdStockByFacilitySiteCommodity(facilityId, dsdSiteName, commodityId, exec = query) {
    const { rows } = await exec(
      `select * from dsd_stock
       where facility_id = $1 and lower(btrim(dsd_site_name)) = lower(btrim($2)) and commodity_id = $3
       limit 1`,
      [facilityId, dsdSiteName, commodityId]
    )
    return rows[0] || null
  }

  /**
   * Get SDP stock by facility + site + commodity. Returns null when not found.
   */
  static async getSdpStockByFacilitySiteCommodity(facilityId, sdpName, commodityId, exec = query) {
    const { rows } = await exec(
      `select * from sdp_stock
       where facility_id = $1 and lower(btrim(sdp_name)) = lower(btrim($2)) and commodity_id = $3
       limit 1`,
      [facilityId, sdpName, commodityId]
    )
    return rows[0] || null
  }

  /**
   * Get a DSD stock row by id (for scope checks / existence). Null if not found.
   */
  static async getDsdStockById(id) {
    const { rows } = await query('select * from dsd_stock where id = $1 limit 1', [id])
    return rows[0] || null
  }

  /**
   * Get an SDP stock row by id (for scope checks / existence). Null if not found.
   */
  static async getSdpStockById(id) {
    const { rows } = await query('select * from sdp_stock where id = $1 limit 1', [id])
    return rows[0] || null
  }

  /**
   * Increment stock quantity atomically.
   */
  static async incrementStock(stockId, amount, exec = query) {
    const { rows } = await exec(
      `update stock set quantity = quantity + $2, updated_at = now()
       where id = $1 returning *`,
      [stockId, parseInt(amount)]
    )
    if (!rows[0]) throw new Error('Stock record not found')
    return rows[0]
  }

  /**
   * Decrement stock quantity atomically (never below 0).
   */
  static async decrementStock(stockId, amount, exec = query) {
    const { rows } = await exec(
      `update stock set quantity = greatest(0, quantity - $2), updated_at = now()
       where id = $1 returning *`,
      [stockId, parseInt(amount)]
    )
    if (!rows[0]) throw new Error('Stock record not found')
    return rows[0]
  }

  /**
   * Check if a commodity exists.
   */
  static async commodityExists(commodityId) {
    const { rows } = await query('select 1 from commodities where id = $1 limit 1', [commodityId])
    return rows.length > 0
  }

  /**
   * Check if a facility exists.
   */
  static async facilityExists(facilityId) {
    const { rows } = await query('select 1 from facilities where id = $1 limit 1', [facilityId])
    return rows.length > 0
  }
}
