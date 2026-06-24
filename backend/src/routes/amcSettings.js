import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceFacilityWrite } from '../middleware/scope.js'
import { AmcSettingsService } from '../services/amcSettingsService.js'

const router = express.Router()

// Auth + scope applied globally to /api (server.js). facility_amc_settings RLS:
// read = public (any authenticated); write = own facility or admin (overall/state/
// cluster/lga). So GET stays open and PUT/DELETE are facility-write scoped.

/**
 * GET /api/amc-settings - List AMC month selections
 * Query params (optional): facility_id
 */
router.get('/', async (req, res) => {
  try {
    const { facility_id } = req.query
    if (facility_id && !validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    const settings = await AmcSettingsService.getAmcSettings({ facilityId: facility_id })
    res.json({
      success: true,
      data: settings,
      count: settings.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching AMC settings:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

/**
 * PUT /api/amc-settings - Upsert a facility's month selection
 * Body: { facility_id, months: string[], updated_by }
 */
router.put('/', async (req, res) => {
  try {
    const { facility_id, months, updated_by } = req.body

    if (!facility_id || !Array.isArray(months) || months.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'facility_id and a non-empty months array are required',
        code: 'MISSING_FIELDS'
      })
    }
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }
    if (!(await enforceFacilityWrite(req, res, facility_id, 'amc_settings'))) return

    const setting = await AmcSettingsService.upsertAmcSettings({ facility_id, months, updated_by })
    res.json({ success: true, data: setting, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error upserting AMC settings:', err)
    res.status(500).json({ success: false, error: err.message, code: 'UPSERT_ERROR' })
  }
})

/**
 * DELETE /api/amc-settings/:facilityId - Revert a facility to the default window
 */
router.delete('/:facilityId', async (req, res) => {
  try {
    const { facilityId } = req.params
    if (!validators.isUUID(facilityId)) {
      return sendValidationError(res, 'Invalid facility id format', 'facilityId')
    }
    if (!(await enforceFacilityWrite(req, res, facilityId, 'amc_settings'))) return

    const deleted = await AmcSettingsService.deleteAmcSettings(facilityId)
    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'No AMC settings for that facility',
        code: 'NOT_FOUND'
      })
    }
    res.json({ success: true, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error deleting AMC settings:', err)
    res.status(500).json({ success: false, error: err.message, code: 'DELETE_ERROR' })
  }
})

export default router
