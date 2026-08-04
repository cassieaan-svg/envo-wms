import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceFacilityRead, enforceFacilityWrite, resolveListFacilityIds, enforceCommoditySection } from '../middleware/scope.js'
import { LogService } from '../services/logService.js'
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
    const base = { adjustment_type, reason, date, from, to, commodityIds, categories: req.scope.sectionCategories, section, limit: parseInt(limit), offset: parseInt(offset) }

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
    console.error('Error updating adjustment record:', err)
    res.status(500).json({ success: false, error: err.message, code: 'UPDATE_ERROR' })
  }
})

export default router
