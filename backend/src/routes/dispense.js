import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceFacilityRead, enforceFacilityWrite, resolveListFacilityIds, enforceCommoditySection } from '../middleware/scope.js'
import { LogService } from '../services/logService.js'
import { StockService } from '../services/stockService.js'

const router = express.Router()

// Auth + scope applied globally to /api (server.js). dispense_log RLS: read =
// own facility or read-admin; write(INSERT) = own facility or is_admin only.

/**
 * POST /api/dispense - Record dispense operation
 * Body: { facility_id, commodity_id, quantity, dispensed_by, dispensed_at (optional),
 *         notes (optional), dsd_site_name or sdp_name (optional), section }
 */
router.post('/', async (req, res) => {
  try {
    const {
      facility_id,
      commodity_id,
      quantity,
      dispensed_by,
      dispensed_at,
      notes,
      dsd_site_name,
      sdp_name,
      section,
      location_type
    } = req.body

    // Validate required fields
    if (!facility_id || !commodity_id || quantity === undefined || !dispensed_by) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: facility_id, commodity_id, quantity, dispensed_by',
        code: 'MISSING_FIELDS'
      })
    }

    // Enforce facility scoping (dispense_log write policy)
    if (!(await enforceFacilityWrite(req, res, facility_id, 'dispense_log'))) return
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

    // Validate quantity is positive
    if (!validators.isPositiveNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be a positive number', 'quantity')
    }

    // Validate dispensed_at if provided
    if (dispensed_at && !validators.isValidDate(dispensed_at)) {
      return sendValidationError(res, 'dispensed_at must be a valid date', 'dispensed_at')
    }

    const dispense = await LogService.recordDispense({
      facility_id,
      commodity_id,
      quantity: parseInt(quantity),
      dispensed_by,
      dispensed_at,
      notes,
      dsd_site_name,
      sdp_name,
      section,
      location_type
    })

    res.status(201).json({
      success: true,
      data: dispense,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error recording dispense:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'DISPENSE_ERROR'
    })
  }
})

/**
 * GET /api/dispense - Get dispense history
 * Query params: facility_id (required), dsd_site_name or sdp_name (optional), date (optional, YYYY-MM-DD)
 */
router.get('/', async (req, res) => {
  try {
    const {
      facility_id, facility_ids, dsd_site_name, sdp_name,
      date, from, to, commodity_ids, section, limit = 1000, offset = 0
    } = req.query

    if (date && date.trim() && !validators.isValidISODate(date)) {
      return sendValidationError(res, 'date must be in YYYY-MM-DD format', 'date')
    }
    const commodityIds = commodity_ids ? String(commodity_ids).split(',').map(s => s.trim()).filter(Boolean) : null
    const base = { dsdSiteName: dsd_site_name, sdpName: sdp_name, date, from, to, commodityIds, categories: req.scope.sectionCategories, section, limit: parseInt(limit), offset: parseInt(offset) }

    let history
    if (facility_id) {
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      if (!(await enforceFacilityRead(req, res, facility_id, 'dispense_log'))) return
      history = await LogService.getDispenseHistory(facility_id, base)
    } else {
      // Scoped/multi-facility path (reports, admin views). Facility set derived
      // from the token, intersected with the optional facility_ids view-filter.
      const facilityIds = await resolveListFacilityIds(req, 'dispense_log', facility_ids)
      history = await LogService.getDispenseHistory(null, { ...base, facilityIds: facilityIds === null ? undefined : facilityIds })
    }

    res.json({
      success: true,
      data: history,
      count: history.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching dispense history:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * GET /api/dispense/summary - consumption summed by commodity + UTC month.
 * The AMC aggregate for dashboards: a few dozen rows instead of every dispense
 * row. Query params mirror the history route (facility_id | facility_ids |
 * state / lga, from, to, commodity_ids, section).
 */
router.get('/summary', async (req, res) => {
  try {
    const { facility_id, facility_ids, from, to, commodity_ids, section } = req.query
    const commodityIds = commodity_ids ? String(commodity_ids).split(',').map(s => s.trim()).filter(Boolean) : null
    const base = { from, to, commodityIds, categories: req.scope.sectionCategories, section }
    let rows
    if (facility_id) {
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      if (!(await enforceFacilityRead(req, res, facility_id, 'dispense_log'))) return
      rows = await LogService.getDispenseSummary(facility_id, base)
    } else {
      const facilityIds = await resolveListFacilityIds(req, 'dispense_log', facility_ids)
      rows = await LogService.getDispenseSummary(null, { ...base, facilityIds: facilityIds === null ? undefined : facilityIds })
    }
    res.json({ success: true, data: rows, count: rows.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching dispense summary:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

/**
 * PATCH /api/dispense/:id - Edit a dispense record (metadata only; the client
 * reconciles stock separately). Scoped to the row's facility (own facility or admin).
 */
router.patch('/:id', async (req, res) => {
  try {
    const row = await LogService.getLogRow('dispense', req.params.id)
    if (!row) return res.status(404).json({ success: false, error: 'Dispense record not found', code: 'NOT_FOUND' })
    if (!(await enforceFacilityWrite(req, res, row.facility_id, 'dispense_log'))) return
    if (!(await enforceCommoditySection(req, res, row.commodity_id))) return

    const updated = await LogService.updateLog('dispense', req.params.id, req.body || {})
    res.json({ success: true, data: updated, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error updating dispense record:', err)
    res.status(500).json({ success: false, error: err.message, code: 'UPDATE_ERROR' })
  }
})

export default router
