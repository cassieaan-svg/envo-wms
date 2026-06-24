import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { EditHistoryService } from '../services/editHistoryService.js'

const router = express.Router()

// Auth applied globally to /api (server.js). NOTE: the edit_history table had no
// RLS policy in supabase_public.sql (audit trail was effectively service-role), so
// there's no per-facility rule to port — these endpoints are auth-only. Adding
// facility scoping here would be a new access model; left as a follow-up.

/**
 * GET /api/edit-history?record_id=… - Audit trail for one log record
 */
router.get('/', async (req, res) => {
  try {
    const { record_id } = req.query
    if (!record_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameter: record_id',
        code: 'MISSING_PARAMS'
      })
    }
    if (!validators.isUUID(record_id)) {
      return sendValidationError(res, 'Invalid record_id format', 'record_id')
    }

    const rows = await EditHistoryService.getByRecord(record_id)
    res.json({
      success: true,
      data: rows,
      count: rows.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching edit history:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

/**
 * POST /api/edit-history - Append an audit entry
 * Body: { record_id, record_type, facility_id, commodity_id,
 *         old_quantity, new_quantity, quantity_diff, edited_by, note }
 */
router.post('/', async (req, res) => {
  try {
    const { record_id, record_type } = req.body

    if (!record_id || !record_type) {
      return res.status(400).json({
        success: false,
        error: 'record_id and record_type are required',
        code: 'MISSING_FIELDS'
      })
    }
    if (!validators.isUUID(record_id)) {
      return sendValidationError(res, 'Invalid record_id format', 'record_id')
    }
    if (!validators.isValidLogEntry(record_type)) {
      return sendValidationError(res, 'Invalid record_type. Must be: dispense, intake, adjustment, or transfer', 'record_type')
    }

    const entry = await EditHistoryService.createEntry(req.body)
    res.status(201).json({ success: true, data: entry, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error creating edit history entry:', err)
    res.status(500).json({ success: false, error: err.message, code: 'CREATE_ERROR' })
  }
})

export default router
