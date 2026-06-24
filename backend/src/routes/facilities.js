import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { FacilityService } from '../services/facilityService.js'

const router = express.Router()

// Auth applied globally to /api (server.js). facilities RLS read = public (any
// authenticated), and there's no write policy — these GET routes need only auth.
// (Admin state/lga narrowing of the facility list is applied client-side, matching
// the original session.js behaviour.)

/**
 * GET /api/facilities - List facilities
 * Query params (all optional): state, lga, name (exact match)
 */
router.get('/', async (req, res) => {
  try {
    const { state, lga, name } = req.query

    const facilities = await FacilityService.getFacilities({ state, lga, name })

    res.json({
      success: true,
      data: facilities,
      count: facilities.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching facilities:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * GET /api/facilities/:id - Get a single facility (full row)
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params

    if (!validators.isUUID(id)) {
      return sendValidationError(res, 'Invalid facility id format', 'id')
    }

    const facility = await FacilityService.getFacilityById(id)
    if (!facility) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
        code: 'FACILITY_NOT_FOUND'
      })
    }

    res.json({
      success: true,
      data: facility,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching facility:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

export default router
