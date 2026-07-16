import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceFacilityRead } from '../middleware/scope.js'
import { BinCardService } from '../services/binCardService.js'

const router = express.Router()

// Auth + scope applied globally to /api (server.js).

/**
 * GET /api/bincard?facility_id=&commodity_id=&location=store
 * Returns a single bin's running ledger (header + rows with running balance).
 */
router.get('/', async (req, res) => {
  try {
    const { facility_id, commodity_id, location = 'store' } = req.query
    if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    if (!validators.isUUID(commodity_id)) return sendValidationError(res, 'Invalid commodity_id format', 'commodity_id')
    if (!(await enforceFacilityRead(req, res, facility_id, 'stock'))) return

    const card = await BinCardService.getBinCard(facility_id, commodity_id, location)
    res.json({ success: true, data: card, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error building bin card:', err)
    res.status(500).json({ success: false, error: err.message, code: 'BINCARD_ERROR' })
  }
})

export default router
