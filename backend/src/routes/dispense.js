import express from 'express'
import { validateQuery, validators, sendValidationError } from '../middleware/validation.js'
import { LogService } from '../services/logService.js'
import { StockService } from '../services/stockService.js'

const router = express.Router()

// TODO: Apply auth middleware in production
// router.use(authMiddleware)

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
      section
    } = req.body

    // Validate required fields
    if (!facility_id || !commodity_id || quantity === undefined || !dispensed_by) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: facility_id, commodity_id, quantity, dispensed_by',
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
      section
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
router.get('/', validateQuery(['facility_id']), async (req, res) => {
  try {
    const { facility_id, dsd_site_name, sdp_name, date, limit = 1000, offset = 0 } = req.query

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

    // Validate date if provided (YYYY-MM-DD format)
    if (date && date.trim() && !validators.isValidISODate(date)) {
      return sendValidationError(res, 'date must be in YYYY-MM-DD format', 'date')
    }

    const history = await LogService.getDispenseHistory(facility_id, {
      dsdSiteName: dsd_site_name,
      sdpName: sdp_name,
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
    console.error('Error fetching dispense history:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

export default router
