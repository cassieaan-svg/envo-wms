import express from 'express'
import { validateQuery, validators, sendValidationError } from '../middleware/validation.js'
import { TransferService } from '../services/transferService.js'
import { StockService } from '../services/stockService.js'

const router = express.Router()

// TODO: Apply auth middleware in production
// router.use(authMiddleware)

/**
 * GET /api/transfers - Get transfers for a facility
 * Query params: facility_id (required), status (optional), type (all|incoming|outgoing)
 */
router.get('/', validateQuery(['facility_id']), async (req, res) => {
  try {
    const { facility_id, status, type = 'all', limit = 1000, offset = 0 } = req.query

    // Validate facility_id
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    // Validate status if provided
    if (status && !validators.isValidTransferStatus(status)) {
      return sendValidationError(res, 'Invalid status. Must be: pending, in_transit, accepted, disputed, or cancelled', 'status')
    }

    // Validate type
    if (!['all', 'incoming', 'outgoing'].includes(type)) {
      return sendValidationError(res, 'Invalid type. Must be: all, incoming, or outgoing', 'type')
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

    const transfers = await TransferService.getTransfers(facility_id, {
      status,
      type,
      limit: parseInt(limit),
      offset: parseInt(offset)
    })

    res.json({
      success: true,
      data: transfers,
      count: transfers.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching transfers:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * POST /api/transfers - Create transfer request
 * Body: { lines[], receiving_facility_id, sending_facility_id, transfer_type, notes, initiated_by, section }
 */
router.post('/', async (req, res) => {
  try {
    const { lines, receiving_facility_id, sending_facility_id, transfer_type, notes, initiated_by, section } = req.body

    // Validate required fields
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'lines array is required with at least one item',
        code: 'MISSING_FIELDS'
      })
    }

    if (!transfer_type) {
      return res.status(400).json({
        success: false,
        error: 'transfer_type is required',
        code: 'MISSING_FIELDS'
      })
    }

    if (!initiated_by) {
      return res.status(400).json({
        success: false,
        error: 'initiated_by is required',
        code: 'MISSING_FIELDS'
      })
    }

    // Validate transfer_type
    if (!validators.isValidTransferType(transfer_type)) {
      return sendValidationError(res, 'Invalid transfer_type', 'transfer_type')
    }

    // Validate each line item
    for (const line of lines) {
      if (!line.commodity_id || line.quantity === undefined) {
        return res.status(400).json({
          success: false,
          error: 'Each line item must have commodity_id and quantity',
          code: 'INVALID_LINE_ITEM'
        })
      }

      if (!validators.isPositiveNumber(line.quantity)) {
        return sendValidationError(res, 'Line quantity must be a positive number', 'quantity')
      }

      // Check commodity exists
      const commodityExists = await StockService.commodityExists(line.commodity_id)
      if (!commodityExists) {
        return res.status(404).json({
          success: false,
          error: `Commodity ${line.commodity_id} not found`,
          code: 'COMMODITY_NOT_FOUND'
        })
      }
    }

    // Validate facilities if provided
    if (receiving_facility_id) {
      const exists = await StockService.facilityExists(receiving_facility_id)
      if (!exists) {
        return res.status(404).json({
          success: false,
          error: 'Receiving facility not found',
          code: 'FACILITY_NOT_FOUND'
        })
      }
    }

    if (sending_facility_id) {
      const exists = await StockService.facilityExists(sending_facility_id)
      if (!exists) {
        return res.status(404).json({
          success: false,
          error: 'Sending facility not found',
          code: 'FACILITY_NOT_FOUND'
        })
      }
    }

    const transfers = await TransferService.createTransfer({
      lines,
      receiving_facility_id,
      sending_facility_id,
      transfer_type,
      notes,
      initiated_by,
      section
    })

    res.status(201).json({
      success: true,
      data: transfers,
      count: transfers.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error creating transfer:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'CREATE_ERROR'
    })
  }
})

/**
 * GET /api/transfers/:id - Get single transfer
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const transfer = await TransferService.getTransferById(id)
    if (!transfer) {
      return res.status(404).json({
        success: false,
        error: 'Transfer not found',
        code: 'TRANSFER_NOT_FOUND'
      })
    }

    res.json({
      success: true,
      data: transfer,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching transfer:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * PATCH /api/transfers/:id/approve - Approve transfer
 * Body: { approved_by, quantity (optional), notes (optional), facility_assignment (for DSD/SDP) }
 */
router.patch('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params
    const { approved_by, quantity, notes, facility_assignment } = req.body

    if (!approved_by) {
      return res.status(400).json({
        success: false,
        error: 'approved_by is required',
        code: 'MISSING_FIELDS'
      })
    }

    if (quantity !== undefined && !validators.isPositiveNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be a positive number', 'quantity')
    }

    const transfer = await TransferService.approveTransfer(id, {
      approved_by,
      quantity,
      notes,
      facility_assignment
    })

    res.json({
      success: true,
      data: transfer,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error approving transfer:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'APPROVE_ERROR'
    })
  }
})

/**
 * PATCH /api/transfers/:id/accept - Accept transfer (receiver side)
 * Body: { accepted_by, notes (optional) }
 */
router.patch('/:id/accept', async (req, res) => {
  try {
    const { id } = req.params
    const { accepted_by, notes } = req.body

    if (!accepted_by) {
      return res.status(400).json({
        success: false,
        error: 'accepted_by is required',
        code: 'MISSING_FIELDS'
      })
    }

    const transfer = await TransferService.acceptTransfer(id, {
      accepted_by,
      notes
    })

    res.json({
      success: true,
      data: transfer,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error accepting transfer:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'ACCEPT_ERROR'
    })
  }
})

/**
 * PATCH /api/transfers/:id/cancel - Cancel transfer
 * Body: { cancelled_by, reason }
 */
router.patch('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params
    const { cancelled_by, reason } = req.body

    if (!cancelled_by) {
      return res.status(400).json({
        success: false,
        error: 'cancelled_by is required',
        code: 'MISSING_FIELDS'
      })
    }

    if (!reason) {
      return res.status(400).json({
        success: false,
        error: 'reason is required',
        code: 'MISSING_FIELDS'
      })
    }

    const transfer = await TransferService.cancelTransfer(id, {
      cancelled_by,
      reason
    })

    res.json({
      success: true,
      data: transfer,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error cancelling transfer:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'CANCEL_ERROR'
    })
  }
})

export default router
