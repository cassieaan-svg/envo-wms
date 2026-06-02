import express from 'express'
import { validateQuery, validators, sendValidationError } from '../middleware/validation.js'
import { LogService } from '../services/logService.js'
import { StockService } from '../services/stockService.js'

const router = express.Router()

// TODO: Apply auth middleware in production
// router.use(authMiddleware)

/**
 * POST /api/intake - Record intake operation
 * Body: { facility_id, commodity_id, quantity, supplier_source, batch_number (optional),
 *         expiry_date (optional), delivery_note_ref (optional), condition_on_arrival (optional),
 *         received_by, received_at (optional), notes (optional), section }
 */
router.post('/', async (req, res) => {
  try {
    const {
      facility_id,
      commodity_id,
      quantity,
      supplier_source,
      batch_number,
      expiry_date,
      delivery_note_ref,
      condition_on_arrival,
      received_by,
      received_at,
      notes,
      section
    } = req.body

    // Validate required fields
    if (!facility_id || !commodity_id || quantity === undefined || !received_by) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: facility_id, commodity_id, quantity, received_by',
        code: 'MISSING_FIELDS'
      })
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

    // Validate quantity is positive
    if (!validators.isPositiveNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be a positive number', 'quantity')
    }

    // Validate received_at if provided
    if (received_at && !validators.isValidDate(received_at)) {
      return sendValidationError(res, 'received_at must be a valid date', 'received_at')
    }

    // Validate expiry_date if provided
    if (expiry_date && !validators.isValidISODate(expiry_date)) {
      return sendValidationError(res, 'expiry_date must be in YYYY-MM-DD format', 'expiry_date')
    }

    const intake = await LogService.recordIntake({
      facility_id,
      commodity_id,
      quantity: parseInt(quantity),
      supplier_source,
      batch_number,
      expiry_date,
      delivery_note_ref,
      condition_on_arrival,
      received_by,
      received_at,
      notes,
      section
    })

    res.status(201).json({
      success: true,
      data: intake,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error recording intake:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'INTAKE_ERROR'
    })
  }
})

/**
 * GET /api/intake - Get intake history
 * Query params: facility_id (required), supplier_source (optional), date (optional, YYYY-MM-DD)
 */
router.get('/', validateQuery(['facility_id']), async (req, res) => {
  try {
    const { facility_id, supplier_source, date, limit = 1000, offset = 0 } = req.query

    // Validate facility_id is UUID
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
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

    const history = await LogService.getIntakeHistory(facility_id, {
      supplier_source,
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
    console.error('Error fetching intake history:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

export default router
