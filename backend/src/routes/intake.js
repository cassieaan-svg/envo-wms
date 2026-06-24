import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceFacilityRead, enforceFacilityWrite, resolveListFacilityIds } from '../middleware/scope.js'
import { LogService } from '../services/logService.js'
import { StockService } from '../services/stockService.js'

const router = express.Router()

// Auth + scope applied globally to /api (server.js). intake_log RLS: read =
// own facility or read-admin; write(INSERT) = own facility or is_admin only.

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

    // Enforce facility scoping (intake_log write policy)
    if (!(await enforceFacilityWrite(req, res, facility_id, 'intake_log'))) return

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
router.get('/', async (req, res) => {
  try {
    const {
      facility_id, facility_ids, supplier_source,
      date, from, to, commodity_ids, section,
      expiry_from, expiry_to, has_quantity, limit = 1000, offset = 0
    } = req.query

    if (date && !validators.isValidISODate(date)) {
      return sendValidationError(res, 'date must be in YYYY-MM-DD format', 'date')
    }
    const commodityIds = commodity_ids ? String(commodity_ids).split(',').map(s => s.trim()).filter(Boolean) : null
    const base = {
      supplier_source, date, from, to, commodityIds, section,
      expiryFrom: expiry_from, expiryTo: expiry_to,
      hasQuantity: has_quantity === 'true' || has_quantity === '1',
      limit: parseInt(limit), offset: parseInt(offset)
    }

    let history
    if (facility_id) {
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      if (!(await enforceFacilityRead(req, res, facility_id, 'intake_log'))) return
      history = await LogService.getIntakeHistory(facility_id, base)
    } else {
      const facilityIds = await resolveListFacilityIds(req, 'intake_log', facility_ids)
      history = await LogService.getIntakeHistory(null, { ...base, facilityIds: facilityIds === null ? undefined : facilityIds })
    }

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

/**
 * PATCH /api/intake/:id - Edit an intake record (metadata only; client reconciles
 * stock). Scoped to the row's facility (own facility or admin).
 */
router.patch('/:id', async (req, res) => {
  try {
    const row = await LogService.getLogRow('intake', req.params.id)
    if (!row) return res.status(404).json({ success: false, error: 'Intake record not found', code: 'NOT_FOUND' })
    if (!(await enforceFacilityWrite(req, res, row.facility_id, 'intake_log'))) return

    const updated = await LogService.updateLog('intake', req.params.id, req.body || {})
    res.json({ success: true, data: updated, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error updating intake record:', err)
    res.status(500).json({ success: false, error: err.message, code: 'UPDATE_ERROR' })
  }
})

export default router
