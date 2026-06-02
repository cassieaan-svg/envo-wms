import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { LogService } from '../services/logService.js'
import { StockService } from '../services/stockService.js'

const router = express.Router()

// TODO: Apply auth middleware in production
// router.use(authMiddleware)

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
      section
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
      section
    })

    res.status(201).json({
      success: true,
      data: adjustment,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error recording adjustment:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'ADJUSTMENT_ERROR'
    })
  }
})

/**
 * GET /api/adjustments - Get adjustment history
 * Query params: facility_id (required), adjustment_type (optional), reason (optional), date (optional, YYYY-MM-DD)
 */
router.get('/', async (req, res) => {
  try {
    const { facility_id, adjustment_type, reason, date, limit = 1000, offset = 0 } = req.query

    // Validate facility_id provided
    if (!facility_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameter: facility_id',
        code: 'MISSING_PARAMS'
      })
    }

    // Validate facility_id is UUID
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    // Validate adjustment_type if provided (before async facility check)
    if (adjustment_type && !['Increase', 'Decrease'].includes(adjustment_type)) {
      return sendValidationError(res, 'adjustment_type must be "Increase" or "Decrease"', 'adjustment_type')
    }

    // Validate facility exists
    const facilityExists = await StockService.facilityExists(facility_id)
    if (!facilityExists) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
        code: 'FACILITY_NOT_FOUND'
      })
    }

    // Validate date if provided
    if (date && !validators.isValidISODate(date)) {
      return sendValidationError(res, 'date must be in YYYY-MM-DD format', 'date')
    }

    const history = await LogService.getAdjustmentHistory(facility_id, {
      adjustment_type,
      reason,
      date,
      limit: parseInt(limit),
      offset: parseInt(offset)
    })

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

export default router
