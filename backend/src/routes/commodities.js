import express from 'express'
import { CommodityService } from '../services/commodityService.js'
import { LogService } from '../services/logService.js'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceFacilityRead, resolveListFacilityIds } from '../middleware/scope.js'

const router = express.Router()

// Auth applied globally to /api (server.js). commodities RLS read = public (any
// authenticated), with no write policy — this GET route needs only auth.

/**
 * GET /api/commodities - List all commodities (ordered category -> name)
 */
router.get('/', async (req, res) => {
  try {
    const commodities = await CommodityService.getCommodities()

    res.json({
      success: true,
      data: commodities,
      count: commodities.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching commodities:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * GET /api/commodities/transacted - ids of commodities this facility (or the
 * caller's scope) has EVER had an intake or dispense record for, however old.
 * Lets the dashboard separate a real stockout from a commodity never handled
 * here. Query: facility_id, or facility_ids / state / lga for an admin scope.
 * Scoped with the dispense_log read policy (same facility model as intake).
 */
router.get('/transacted', async (req, res) => {
  try {
    const { facility_id, facility_ids } = req.query
    let ids
    if (facility_id) {
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      if (!(await enforceFacilityRead(req, res, facility_id, 'dispense_log'))) return
      ids = await LogService.getTransactedCommodityIds(facility_id)
    } else {
      const facilityIds = await resolveListFacilityIds(req, 'dispense_log', facility_ids)
      ids = await LogService.getTransactedCommodityIds(null, { facilityIds: facilityIds === null ? undefined : facilityIds })
    }
    res.json({ success: true, data: ids, count: ids.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching transacted commodities:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

export default router
