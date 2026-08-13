import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceFacilityRead, enforceFacilityWrite, scopedReadFacilityIds, enforceCommoditySection, locationFacilityIds, resolveListFacilityIds, sectionFilter } from '../middleware/scope.js'
import { categoriesForSection, narrowGrantsToCategories } from '../constants/sections.js'
import { StockService } from '../services/stockService.js'

const router = express.Router()

// Auth (authMiddleware) and scope (attachScope) are applied globally to /api in
// server.js, so every handler below can assume req.user / req.scope exist. Each
// route additionally enforces facility scoping via enforceFacilityRead/Write,
// mirroring the Supabase RLS policies for the stock / dsd_stock / sdp_stock tables.

/**
 * GET /api/stock - Get stock records for a facility
 * Query params: facility_id (required), commodity_id (optional), location_type (optional)
 */
router.get('/', async (req, res) => {
  try {
    const { facility_id, facility_ids, commodity_id, commodity_ids, location_type, limit = 1000, offset = 0 } = req.query

    // Validate location_type if provided (applies to both paths)
    if (location_type && !validators.isValidLocationTypes(location_type)) {
      return sendValidationError(res, 'Invalid location_type. Must be: store or dispensary', 'location_type')
    }

    // ── Multi-facility scoped path: no facility_id → the caller's whole scope ──
    // Used by admin/aggregate views (useStock, Dashboard, Monitoring, …). The
    // returned facility set is derived from the token; an optional `facility_ids`
    // client view-filter is INTERSECTED with that scope (a narrowed admin can't
    // widen their access by passing ids outside their scope).
    if (!facility_id) {
      const csv = v => v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : null
      let facilityIds = await scopedReadFacilityIds(req, 'stock') // null=all, []=none, [...]
      let clientFids = csv(facility_ids)
      // Compact state/LGA view-filter (avoids enumerating ids in the URL).
      const loc = await locationFacilityIds(req)
      if (loc) clientFids = clientFids ? clientFids.filter(id => loc.includes(id)) : loc
      if (clientFids) {
        facilityIds = facilityIds === null ? clientFids : facilityIds.filter(id => clientFids.includes(id))
      }
      const commodityIds = csv(commodity_ids)
      const stock = await StockService.getScopedStock({
        facilityIds, commodityIds, ...sectionFilter(req),
        limit: parseInt(limit), offset: parseInt(offset)
      })
      return res.json({ success: true, data: stock, count: stock.length, timestamp: new Date().toISOString() })
    }

    // ── Single-facility path ──
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    // Enforce facility scoping (stock read policy)
    if (!(await enforceFacilityRead(req, res, facility_id, 'stock'))) return

    // Check if facility exists
    const facilityExists = await StockService.facilityExists(facility_id)
    if (!facilityExists) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
        code: 'FACILITY_NOT_FOUND'
      })
    }

    const stock = await StockService.getStock(facility_id, {
      commodityId: commodity_id,
      locationType: location_type,
      ...sectionFilter(req),
      limit: parseInt(limit),
      offset: parseInt(offset)
    })

    res.json({
      success: true,
      data: stock,
      count: stock.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching stock:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * GET /api/stock/summary - PER-COMMODITY stock rollup across the caller's scope.
 *
 * Replaces the "download every stock/dsd/sdp row and reduce it in the browser"
 * pattern behind the dashboards, stock tables and alert counts: those views only
 * ever needed one row per commodity, so this returns exactly that (~17 KB for an
 * overall admin, vs ~5.6 MB of raw rows + ~1.1 MB of DSD/SDP pages). The response
 * size tracks the commodity catalogue, not the number of stock rows, so it stays
 * flat as the database grows.
 *
 * Query params (all optional): facility_id (single-facility path), facility_ids
 * (CSV view-filter), state / lga (compact location view-filter), commodity_ids
 * (CSV, e.g. a section-filtered catalogue).
 *
 * Scoping is identical to GET /api/stock: the token's readable facility set for
 * the `stock` table, INTERSECTED with any client view-filter, so a narrowed admin
 * can never widen their access by passing ids outside their scope. Note this
 * applies the `stock` scope to the dsd_stock / sdp_stock aggregates too — those
 * list endpoints are public-read (RLS USING true) and filtered by the client
 * filter alone. That is never WIDER than the existing endpoints, and the callers
 * being migrated already pass their own scope ids, so the numbers are unchanged.
 * Section enforcement uses req.scope.sectionCategories, as elsewhere.
 *
 * Declared before '/:id' so it isn't shadowed.
 */
router.get('/summary', async (req, res) => {
  try {
    const { facility_id, facility_ids, commodity_ids, group_by, commodity_id } = req.query
    const csv = v => v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : null

    // Grain, from an explicit allowlist rather than a free-form GROUP BY:
    //   commodity (default) — one row per commodity, what the dashboards use
    //   facility            — one row per (commodity, facility), for All Facilities'
    //                         reporting-site counts and its per-commodity drill-down
    const grain = group_by ? String(group_by) : 'commodity'
    if (!['commodity', 'facility'].includes(grain)) {
      return sendValidationError(res, 'Unsupported group_by. Must be: commodity | facility', 'group_by')
    }
    if (commodity_id && !validators.isUUID(commodity_id)) {
      return sendValidationError(res, 'Invalid commodity_id format', 'commodity_id')
    }

    let facilityIds
    if (facility_id) {
      // Single-facility path: enforce read on that one facility, then scope to it.
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      if (!(await enforceFacilityRead(req, res, facility_id, 'stock'))) return
      facilityIds = [facility_id]
    } else {
      // Multi-facility scoped path (admin/aggregate), mirroring GET /stock.
      facilityIds = await resolveListFacilityIds(req, 'stock', facility_ids)
    }

    const args = {
      facilityIds,
      commodityIds: csv(commodity_ids),
      ...sectionFilter(req),
    }
    const summary = grain === 'facility'
      ? await StockService.getScopedStockByFacility({ ...args, commodityId: commodity_id || null })
      : await StockService.getScopedStockSummary(args)

    res.json({ success: true, data: summary, count: summary.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching stock summary:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

/**
 * GET /api/stock/lots - on-hand lots (per-batch balances) of ONE bin, from the
 * lot ledger, soonest-expiry first. Powers the dispense batch picker.
 * Query: facility_id, commodity_id, location_type (store|dispensary|dsd|sdp),
 * site_name (required for dsd/sdp). Declared before '/:id' so it isn't shadowed.
 */
router.get('/lots', async (req, res) => {
  try {
    const { facility_id, commodity_id, location_type, site_name } = req.query
    if (!facility_id || !commodity_id || !location_type) {
      return sendValidationError(res, 'facility_id, commodity_id and location_type are required', 'facility_id')
    }
    if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    if (!['store', 'dispensary', 'dsd', 'sdp'].includes(location_type)) {
      return sendValidationError(res, 'location_type must be store, dispensary, dsd or sdp', 'location_type')
    }
    if (!(await enforceFacilityRead(req, res, facility_id, 'stock'))) return
    const lots = await StockService.getBinLots({ facility_id, commodity_id, location_type, site_name: site_name || null })
    res.json({ success: true, data: lots, count: lots.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching bin lots:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

/**
 * GET /api/stock/lots/expiry - on-hand per-batch balances across the caller's
 * scope, from the AUTHORITATIVE lot ledger (not the intake-history estimate), so
 * expired / received-expired stock still on hand surfaces and the per-batch
 * quantities reconcile to the bin totals. Powers the expiry dashboards, the
 * expiry alerts, and the stock-by-batch modal.
 * Query: optional facility_id (single-facility path), optional facility_ids /
 * commodity_ids (view-filter, intersected with scope), optional expiry_to (ISO)
 * to cap the look-ahead, include_unknown=1 to also return null-expiry lots.
 * Declared before '/:id' so it isn't shadowed. Section-scoped via sectionCategories.
 */
router.get('/lots/expiry', async (req, res) => {
  try {
    const { facility_id, facility_ids, commodity_ids, expiry_to, include_unknown, section } = req.query
    const csv = v => v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : null
    if (expiry_to && !validators.isValidISODate(String(expiry_to))) {
      return sendValidationError(res, 'expiry_to must be a valid YYYY-MM-DD date', 'expiry_to')
    }

    // Section: the token already pins section-restricted callers to their categories
    // (req.scope.sectionCategories). An explicit `section` (e.g. the lab-specific
    // page viewed by a null-section admin) narrows further — intersect the two so a
    // caller can never widen past their token scope.
    const sectionCats = categoriesForSection(section)
    const tokenCats = req.scope.sectionCategories
    let categories = tokenCats
    let commodityNames = req.scope.sectionCommodityNames
    if (Array.isArray(sectionCats)) {
      categories = Array.isArray(tokenCats) ? tokenCats.filter(c => sectionCats.includes(c)) : sectionCats
      // Individually-granted commodities narrow the same way — keep only those whose
      // own category is in the requested section.
      commodityNames = narrowGrantsToCategories(commodityNames, sectionCats)
    }

    let facilityIds
    if (facility_id) {
      // Single-facility path: enforce read on that one facility, then scope to it.
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      if (!(await enforceFacilityRead(req, res, facility_id, 'stock'))) return
      facilityIds = [facility_id]
    } else {
      // Multi-facility scoped path (admin/aggregate), mirroring GET /stock: the
      // token's readable set, optionally intersected with a state/LGA or explicit
      // facility_ids view-filter (a narrowed admin can't widen their access).
      facilityIds = await scopedReadFacilityIds(req, 'stock') // null=all, []=none
      let clientFids = csv(facility_ids)
      const loc = await locationFacilityIds(req)
      if (loc) clientFids = clientFids ? clientFids.filter(id => loc.includes(id)) : loc
      if (clientFids) {
        facilityIds = facilityIds === null ? clientFids : facilityIds.filter(id => clientFids.includes(id))
      }
    }

    const lots = await StockService.getScopedLots({
      facilityIds, commodityIds: csv(commodity_ids), categories, commodityNames,
      expiryTo: expiry_to || null, includeUnknown: include_unknown === '1' || include_unknown === 'true',
    })
    res.json({ success: true, data: lots, count: lots.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching scoped lots:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

/**
 * PATCH /api/stock/lots/:id - record a lot's batch / expiry (metadata only; the
 * quantity is never touched). Used to label the "unknown expiry" lots the ledger
 * seed produced. Body: { batch_number, expiry_date }. Store-manager scoped via
 * enforceFacilityWrite on the lot's own facility.
 */
router.patch('/lots/:id', async (req, res) => {
  try {
    const { batch_number, expiry_date } = req.body || {}
    const lot = await StockService.getLotById(req.params.id)
    if (!lot) {
      return res.status(404).json({ success: false, error: 'Lot not found', code: 'LOT_NOT_FOUND' })
    }
    if (!(await enforceFacilityWrite(req, res, lot.facility_id, 'stock'))) return
    // A blank expiry clears it (back to unknown); a non-blank one must be a real,
    // plausible date — reject rather than silently storing "unknown".
    if (expiry_date && !validators.isValidISODate(String(expiry_date))) {
      return sendValidationError(res, 'expiry_date must be a valid YYYY-MM-DD date', 'expiry_date')
    }
    const updated = await StockService.relabelLot(req.params.id, { batch_number, expiry_date })
    res.json({ success: true, data: updated, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error updating lot:', err)
    res.status(500).json({ success: false, error: err.message, code: 'LOT_UPDATE_ERROR' })
  }
})

/**
 * GET /api/stock/dsd - Get DSD stock for a facility
 * Query params: facility_id (required), dsd_site_name (optional)
 */
router.get('/dsd', async (req, res) => {
  try {
    const { facility_id, facility_ids, dsd_site_name, commodity_id, limit = 1000, offset = 0 } = req.query

    if (facility_id && !validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }
    // dsd_stock read is public (RLS USING true); a facility_ids / state / lga
    // view-filter just narrows the result set. No per-facility authz needed here.
    let facilityIds = facility_ids ? String(facility_ids).split(',').map(s => s.trim()).filter(Boolean) : undefined
    const loc = await locationFacilityIds(req)
    if (loc) facilityIds = facilityIds ? facilityIds.filter(id => loc.includes(id)) : loc

    const stock = await StockService.getDsdStock(facility_id || null, {
      dsdSiteName: dsd_site_name,
      commodityId: commodity_id,
      facilityIds,
      ...sectionFilter(req),
      limit: parseInt(limit),
      offset: parseInt(offset)
    })

    res.json({
      success: true,
      data: stock,
      count: stock.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching DSD stock:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * GET /api/stock/sdp - Get SDP stock for a facility
 * Query params: facility_id (required), sdp_name (optional)
 */
router.get('/sdp', async (req, res) => {
  try {
    const { facility_id, facility_ids, sdp_name, commodity_id, limit = 1000, offset = 0 } = req.query

    if (facility_id && !validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }
    // sdp_stock read is public (RLS USING true); facility_ids / state / lga narrows.
    let facilityIds = facility_ids ? String(facility_ids).split(',').map(s => s.trim()).filter(Boolean) : undefined
    const loc = await locationFacilityIds(req)
    if (loc) facilityIds = facilityIds ? facilityIds.filter(id => loc.includes(id)) : loc

    const stock = await StockService.getSdpStock(facility_id || null, {
      sdpName: sdp_name,
      commodityId: commodity_id,
      facilityIds,
      ...sectionFilter(req),
      limit: parseInt(limit),
      offset: parseInt(offset)
    })

    res.json({
      success: true,
      data: stock,
      count: stock.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching SDP stock:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * PUT /api/stock/upsert - Upsert store/dispensary stock by natural key
 * Body: { facility_id, commodity_id, location_type, quantity }
 * Sets an absolute quantity; inserts if the (facility, commodity, location)
 * row doesn't exist, updates it if it does.
 */
router.put('/upsert', async (req, res) => {
  try {
    const { facility_id, commodity_id, location_type, quantity } = req.body

    if (!facility_id || !commodity_id || !location_type || quantity === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: facility_id, commodity_id, location_type, quantity',
        code: 'MISSING_FIELDS'
      })
    }
    if (!validators.isValidLocationTypes(location_type)) {
      return sendValidationError(res, 'Invalid location_type. Must be: store or dispensary', 'location_type')
    }
    if (!validators.isNonNegativeNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be a non-negative number', 'quantity')
    }
    if (!(await enforceFacilityWrite(req, res, facility_id, 'stock'))) return
    if (!(await enforceCommoditySection(req, res, commodity_id))) return

    const stock = await StockService.upsertStock({ facility_id, commodity_id, location_type, quantity })
    res.json({ success: true, data: stock, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error upserting stock:', err)
    res.status(500).json({ success: false, error: err.message, code: 'UPSERT_ERROR' })
  }
})

/**
 * PUT /api/stock/dsd/upsert - Upsert DSD site stock by natural key
 * Body: { facility_id, dsd_site_name, commodity_id, quantity }
 */
router.put('/dsd/upsert', async (req, res) => {
  try {
    const { facility_id, dsd_site_name, commodity_id, quantity } = req.body

    if (!facility_id || !dsd_site_name || !commodity_id || quantity === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: facility_id, dsd_site_name, commodity_id, quantity',
        code: 'MISSING_FIELDS'
      })
    }
    if (!validators.isNonNegativeNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be a non-negative number', 'quantity')
    }
    if (!(await enforceFacilityWrite(req, res, facility_id, 'dsd_stock'))) return
    if (!(await enforceCommoditySection(req, res, commodity_id))) return

    const stock = await StockService.upsertDsdStock({ facility_id, dsd_site_name, commodity_id, quantity })
    res.json({ success: true, data: stock, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error upserting DSD stock:', err)
    res.status(500).json({ success: false, error: err.message, code: 'UPSERT_ERROR' })
  }
})

/**
 * PUT /api/stock/sdp/upsert - Upsert SDP site stock by natural key
 * Body: { facility_id, sdp_name, commodity_id, quantity }
 */
router.put('/sdp/upsert', async (req, res) => {
  try {
    const { facility_id, sdp_name, commodity_id, quantity } = req.body

    if (!facility_id || !sdp_name || !commodity_id || quantity === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: facility_id, sdp_name, commodity_id, quantity',
        code: 'MISSING_FIELDS'
      })
    }
    if (!validators.isNonNegativeNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be a non-negative number', 'quantity')
    }
    if (!(await enforceFacilityWrite(req, res, facility_id, 'sdp_stock'))) return
    if (!(await enforceCommoditySection(req, res, commodity_id))) return

    const stock = await StockService.upsertSdpStock({ facility_id, sdp_name, commodity_id, quantity })
    res.json({ success: true, data: stock, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error upserting SDP stock:', err)
    res.status(500).json({ success: false, error: err.message, code: 'UPSERT_ERROR' })
  }
})

/**
 * PATCH /api/stock/dsd/:id - Set DSD site stock quantity (absolute) by id
 * Body: { quantity }
 */
router.patch('/dsd/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { quantity } = req.body

    if (quantity === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required field: quantity', code: 'MISSING_FIELDS' })
    }
    if (!validators.isNonNegativeNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be a non-negative number', 'quantity')
    }

    const existing = await StockService.getDsdStockById(id)
    if (!existing) {
      return res.status(404).json({ success: false, error: 'DSD stock record not found', code: 'STOCK_NOT_FOUND' })
    }
    if (!(await enforceFacilityWrite(req, res, existing.facility_id, 'dsd_stock'))) return
    if (!(await enforceCommoditySection(req, res, existing.commodity_id))) return

    const updated = await StockService.updateDsdStock(id, quantity)
    if (!updated) {
      return res.status(404).json({ success: false, error: 'DSD stock record not found', code: 'STOCK_NOT_FOUND' })
    }
    res.json({ success: true, data: updated, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error updating DSD stock:', err)
    res.status(500).json({ success: false, error: err.message, code: 'UPDATE_ERROR' })
  }
})

/**
 * PATCH /api/stock/sdp/:id - Set SDP site stock quantity (absolute) by id
 * Body: { quantity }
 */
router.patch('/sdp/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { quantity } = req.body

    if (quantity === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required field: quantity', code: 'MISSING_FIELDS' })
    }
    if (!validators.isNonNegativeNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be a non-negative number', 'quantity')
    }

    const existing = await StockService.getSdpStockById(id)
    if (!existing) {
      return res.status(404).json({ success: false, error: 'SDP stock record not found', code: 'STOCK_NOT_FOUND' })
    }
    if (!(await enforceFacilityWrite(req, res, existing.facility_id, 'sdp_stock'))) return
    if (!(await enforceCommoditySection(req, res, existing.commodity_id))) return

    const updated = await StockService.updateSdpStock(id, quantity)
    if (!updated) {
      return res.status(404).json({ success: false, error: 'SDP stock record not found', code: 'STOCK_NOT_FOUND' })
    }
    res.json({ success: true, data: updated, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error updating SDP stock:', err)
    res.status(500).json({ success: false, error: err.message, code: 'UPDATE_ERROR' })
  }
})

/**
 * POST /api/stock - Create stock record
 * Body: { facility_id, commodity_id, quantity, location_type, section }
 */
router.post('/', async (req, res) => {
  try {
    const { facility_id, commodity_id, quantity, location_type, section } = req.body

    // Validate required fields
    if (!facility_id || !commodity_id || quantity === undefined || !location_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: facility_id, commodity_id, quantity, location_type',
        code: 'MISSING_FIELDS'
      })
    }

    // Validate quantity is positive
    if (!validators.isNonNegativeNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be a non-negative number', 'quantity')
    }

    // Validate location_type
    if (!validators.isValidLocationTypes(location_type)) {
      return sendValidationError(res, 'Invalid location_type. Must be: store or dispensary', 'location_type')
    }

    // Enforce facility scoping (stock write policy)
    if (!(await enforceFacilityWrite(req, res, facility_id, 'stock'))) return
    if (!(await enforceCommoditySection(req, res, commodity_id))) return

    // Validate facility exists
    const facilityExists = await StockService.facilityExists(facility_id)
    if (!facilityExists) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
        code: 'FACILITY_NOT_FOUND'
      })
    }

    // Validate commodity exists
    const commodityExists = await StockService.commodityExists(commodity_id)
    if (!commodityExists) {
      return res.status(404).json({
        success: false,
        error: 'Commodity not found',
        code: 'COMMODITY_NOT_FOUND'
      })
    }

    const stock = await StockService.createStock({
      facility_id,
      commodity_id,
      quantity,
      location_type,
      section
    })

    res.status(201).json({
      success: true,
      data: stock,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error creating stock:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'CREATE_ERROR'
    })
  }
})

/**
 * PATCH /api/stock/:id - Update stock quantity
 * Body: { quantity }
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { quantity } = req.body

    // Validate quantity
    if (quantity === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: quantity',
        code: 'MISSING_FIELDS'
      })
    }

    if (!validators.isNonNegativeNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be a non-negative number', 'quantity')
    }

    // Verify stock exists
    const stock = await StockService.getStockById(id)
    if (!stock) {
      return res.status(404).json({
        success: false,
        error: 'Stock record not found',
        code: 'STOCK_NOT_FOUND'
      })
    }
    if (!(await enforceFacilityWrite(req, res, stock.facility_id, 'stock'))) return
    if (!(await enforceCommoditySection(req, res, stock.commodity_id, stock.commodities?.category))) return

    const updated = await StockService.updateStock(id, { quantity })

    res.json({
      success: true,
      data: updated,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error updating stock:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'UPDATE_ERROR'
    })
  }
})

/**
 * GET /api/stock/:id - Get stock by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const stock = await StockService.getStockById(id)
    if (!stock) {
      return res.status(404).json({
        success: false,
        error: 'Stock record not found',
        code: 'STOCK_NOT_FOUND'
      })
    }
    if (!(await enforceFacilityRead(req, res, stock.facility_id, 'stock'))) return
    if (!(await enforceCommoditySection(req, res, stock.commodity_id, stock.commodities?.category))) return

    res.json({
      success: true,
      data: stock,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching stock:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

export default router
