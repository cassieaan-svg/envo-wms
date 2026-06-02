import express from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { validateQuery, validators, sendValidationError } from '../middleware/validation.js'
import { StockService } from '../services/stockService.js'

const router = express.Router()

// TODO: Apply auth middleware to all stock routes in production
// For now, bypassing auth for testing
// router.use(authMiddleware)

/**
 * GET /api/stock - Get stock records for a facility
 * Query params: facility_id (required), commodity_id (optional), location_type (optional)
 */
router.get('/', validateQuery(['facility_id']), async (req, res) => {
  try {
    const { facility_id, commodity_id, location_type, limit = 1000, offset = 0 } = req.query

    // Validate facility_id is a UUID
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    // Validate location_type if provided
    if (location_type && !validators.isValidLocationTypes(location_type)) {
      return sendValidationError(res, 'Invalid location_type. Must be: store or dispensary', 'location_type')
    }

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
 * GET /api/stock/dsd - Get DSD stock for a facility
 * Query params: facility_id (required), dsd_site_name (optional)
 */
router.get('/dsd', validateQuery(['facility_id']), async (req, res) => {
  try {
    const { facility_id, dsd_site_name, limit = 1000, offset = 0 } = req.query

    // Validate facility_id
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    // Check if facility exists
    const facilityExists = await StockService.facilityExists(facility_id)
    if (!facilityExists) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
        code: 'FACILITY_NOT_FOUND'
      })
    }

    const stock = await StockService.getDsdStock(facility_id, {
      dsdSiteName: dsd_site_name,
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
router.get('/sdp', validateQuery(['facility_id']), async (req, res) => {
  try {
    const { facility_id, sdp_name, limit = 1000, offset = 0 } = req.query

    // Validate facility_id
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    // Check if facility exists
    const facilityExists = await StockService.facilityExists(facility_id)
    if (!facilityExists) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
        code: 'FACILITY_NOT_FOUND'
      })
    }

    const stock = await StockService.getSdpStock(facility_id, {
      sdpName: sdp_name,
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
