import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceFacilityRead, enforceFacilityWrite, resolveListFacilityIds, enforceCommoditySection, sectionFilter } from '../middleware/scope.js'
import { narrowGrantsToCategories } from '../constants/sections.js'
import { LogService, ADJUSTMENT_GROUP_BY_KEYS } from '../services/logService.js'
import { StockService } from '../services/stockService.js'

const router = express.Router()

// Auth + scope applied globally to /api (server.js). stock_adjustment_log RLS: read =
// own facility or read-admin; write(INSERT) = own facility or is_admin only.

/**
 * POST /api/adjustments - Record stock adjustment
 * Body: { facility_id, commodity_id, quantity, adjustment_type (Increase|Decrease),
 *         reason, adjusted_by, reference_number (optional), notes (optional),
 *         adjusted_at (optional), expiry_date (optional), batch_number (optional), section }
 */
router.post('/', async (req, res) => {
  try {
    const {
      facility_id,
      commodity_id,
      quantity,
      adjustment_type,
      reason,
      adjusted_by,
      reference_number,
      notes,
      adjusted_at,
      expiry_date,
      batch_number,
      section,
      location_type,
      site_name
    } = req.body

    // Validate required fields
    if (!facility_id || !commodity_id || quantity === undefined || !adjustment_type || !reason || !adjusted_by) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: facility_id, commodity_id, quantity, adjustment_type, reason, adjusted_by',
        code: 'MISSING_FIELDS'
      })
    }

    // Validate quantity is positive
    if (!validators.isPositiveNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be a positive number', 'quantity')
    }

    // Validate adjustment_type first (no async call needed)
    if (!['Increase', 'Decrease'].includes(adjustment_type)) {
      return sendValidationError(res, 'adjustment_type must be "Increase" or "Decrease"', 'adjustment_type')
    }

    // Enforce facility scoping (adjustment write policy)
    if (!(await enforceFacilityWrite(req, res, facility_id, 'adjustment_log'))) return
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

    // Validate adjusted_at if provided
    if (adjusted_at && !validators.isValidDate(adjusted_at)) {
      return sendValidationError(res, 'adjusted_at must be a valid date', 'adjusted_at')
    }

    // Validate expiry_date if provided
    if (expiry_date && !validators.isValidISODate(expiry_date)) {
      return sendValidationError(res, 'expiry_date must be in YYYY-MM-DD format', 'expiry_date')
    }

    const adjustment = await LogService.recordAdjustment({
      facility_id,
      commodity_id,
      quantity: parseInt(quantity),
      adjustment_type,
      reason,
      adjusted_by,
      reference_number,
      notes,
      adjusted_at,
      expiry_date,
      batch_number,
      section,
      location_type,
      site_name
    })

    res.status(201).json({
      success: true,
      data: adjustment,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    // 400 = a required field (e.g. compulsory notes); 409 = the bin cannot cover the
    // decrease. Both are expected refusals, not server faults, so pass the real
    // message through instead of flattening everything to 500.
    const status = [400, 409].includes(err.status) ? err.status : 500
    if (status === 500) console.error('Error recording adjustment:', err)
    res.status(status).json({
      success: false,
      error: err.message,
      code: status === 409 ? 'INSUFFICIENT_STOCK' : status === 400 ? 'VALIDATION_ERROR' : 'ADJUSTMENT_ERROR'
    })
  }
})

/**
 * GET /api/adjustments/summary - adjustments aggregated server-side.
 *
 * Same contract as the dispense / intake / transfer summaries — allowlisted
 * group_by, same scope and section enforcement, same { qty, txn } rows — so
 * Monitoring's Adjustments tab is built exactly like its siblings. Adds the
 * `type` (Increase / Decrease) and `reason` dimensions, and an `adjustment_type`
 * filter to request one direction on its own.
 *
 * MUST stay above any '/:id' route so 'summary' is not read as an id.
 */
router.get('/summary', async (req, res) => {
  try {
    const { facility_id, facility_ids, from, to, commodity_ids, section,
            group_by, commodity_id, category, tz, adjustment_type, reason } = req.query
    const commodityIds = commodity_ids ? String(commodity_ids).split(',').map(s => s.trim()).filter(Boolean) : null

    const groupBy = group_by ? String(group_by) : 'commodity,type'
    if (!ADJUSTMENT_GROUP_BY_KEYS.includes(groupBy)) {
      return sendValidationError(res,
        `Unsupported group_by. Must be one of: ${ADJUSTMENT_GROUP_BY_KEYS.join(' | ')}`, 'group_by')
    }
    if (adjustment_type && !['Increase', 'Decrease'].includes(adjustment_type)) {
      return sendValidationError(res, 'adjustment_type must be "Increase" or "Decrease"', 'adjustment_type')
    }
    if (commodity_id && !validators.isUUID(commodity_id)) {
      return sendValidationError(res, 'Invalid commodity_id format', 'commodity_id')
    }
    if (tz && !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(String(tz))) {
      return sendValidationError(res, 'Invalid tz', 'tz')
    }

    // A `category` drill must stay inside the caller's section, never widen it.
    const tokenCats = req.scope.sectionCategories
    const grants = req.scope.sectionCommodityNames
    const viaGrant = !!category && narrowGrantsToCategories(grants, [String(category)]).length > 0
    if (category && Array.isArray(tokenCats) && !tokenCats.includes(String(category)) && !viaGrant) {
      return res.json({ success: true, data: [], count: 0, timestamp: new Date().toISOString() })
    }

    const base = {
      from, to, commodityIds, categories: tokenCats, commodityNames: grants, section,
      groupBy, commodityId: commodity_id || null, category: category || null, tz: tz || null,
      adjustmentType: adjustment_type || null,
      reason: reason || null,
    }
    let rows
    if (facility_id) {
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      if (!(await enforceFacilityRead(req, res, facility_id, 'adjustment_log'))) return
      rows = await LogService.getAdjustmentSummary(facility_id, base)
    } else {
      const facilityIds = await resolveListFacilityIds(req, 'adjustment_log', facility_ids)
      rows = await LogService.getAdjustmentSummary(null, { ...base, facilityIds: facilityIds === null ? undefined : facilityIds })
    }
    res.json({ success: true, data: rows, count: rows.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching adjustment summary:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

/**
 * GET /api/adjustments - Get adjustment history
 * Query params: facility_id (required), adjustment_type (optional), reason (optional), date (optional, YYYY-MM-DD)
 */
router.get('/', async (req, res) => {
  try {
    const {
      facility_id, facility_ids, adjustment_type, reason,
      date, from, to, commodity_ids, section, limit = 1000, offset = 0
    } = req.query

    if (adjustment_type && !['Increase', 'Decrease'].includes(adjustment_type)) {
      return sendValidationError(res, 'adjustment_type must be "Increase" or "Decrease"', 'adjustment_type')
    }
    if (date && !validators.isValidISODate(date)) {
      return sendValidationError(res, 'date must be in YYYY-MM-DD format', 'date')
    }
    const commodityIds = commodity_ids ? String(commodity_ids).split(',').map(s => s.trim()).filter(Boolean) : null
    const base = { adjustment_type, reason, date, from, to, commodityIds, ...sectionFilter(req), section, limit: parseInt(limit), offset: parseInt(offset) }

    let history
    if (facility_id) {
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      if (!(await enforceFacilityRead(req, res, facility_id, 'adjustment_log'))) return
      history = await LogService.getAdjustmentHistory(facility_id, base)
    } else {
      const facilityIds = await resolveListFacilityIds(req, 'adjustment_log', facility_ids)
      history = await LogService.getAdjustmentHistory(null, { ...base, facilityIds: facilityIds === null ? undefined : facilityIds })
    }

    res.json({
      success: true,
      data: history,
      count: history.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching adjustment history:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * PATCH /api/adjustments/:id - Edit an adjustment record (metadata only; client
 * reconciles stock). Scoped to the row's facility (own facility or admin).
 */
router.patch('/:id', async (req, res) => {
  try {
    const row = await LogService.getLogRow('adjustment', req.params.id)
    if (!row) return res.status(404).json({ success: false, error: 'Adjustment record not found', code: 'NOT_FOUND' })
    if (!(await enforceFacilityWrite(req, res, row.facility_id, 'adjustment_log'))) return
    if (!(await enforceCommoditySection(req, res, row.commodity_id))) return

    const updated = await LogService.updateLog('adjustment', req.params.id, req.body || {})
    res.json({ success: true, data: updated, timestamp: new Date().toISOString() })
  } catch (err) {
    // A rejected edit (missing batch on an "Expired" write-off, or a change the bin
    // can't cover) is the caller's to fix, not a server fault. Pass the status the
    // service chose through, so the UI shows the real reason instead of a generic
    // error — and keep 500 only for what is genuinely unexpected.
    const status = err.status === 400 || err.status === 409 ? err.status : 500
    if (status === 500) console.error('Error updating adjustment record:', err)
    res.status(status).json({
      success: false,
      error: err.message,
      code: status === 400 ? 'VALIDATION_ERROR' : status === 409 ? 'INSUFFICIENT_STOCK' : 'UPDATE_ERROR',
    })
  }
})

export default router
