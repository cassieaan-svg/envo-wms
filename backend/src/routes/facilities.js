import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { FacilityService } from '../services/facilityService.js'
import { enforceModuleAccess, scopedModule } from '../middleware/scope.js'

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
    if (!(await enforceModuleAccess(req, res))) return
    const { state, lga, cluster, name, all } = req.query

    // `?all=true` — the escape hatch for administration screens (Create User's
    // facility picker) that need the WHOLE roster to assign a scope, not just
    // the caller's own ambient active module. Facility metadata (name/state/
    // lga/level) was already public to any authenticated caller before the
    // module filter existed — see the file header — so this widens nothing
    // that wasn't already readable, it just stops silently hiding facilities
    // from the picker because of an unrelated session's active module (a
    // system_admin that never picks one, say, defaults to 'hiv' and would
    // otherwise never see the Essential roster here).
    const wantsAll = all === 'true' || all === '1'

    // An essential_admin is confined to its own state and, when it carries one, to one
    // facility level (Primary or Secondary). Enforced here rather than left to the client:
    // stock, requests and users are already narrowed this way, but this list feeds every
    // facility dropdown and filter, so a Primary admin was still being shown Secondary
    // facilities. Applied to `all=true` too — a level-confined admin can only create
    // accounts at its own level anyway (createUser refuses the rest).
    const s = req.scope
    const confined = s?.accessLevel === 'essential_admin'
    const facilities = await FacilityService.getFacilities({
      state: (confined && s.adminState) || state,
      level: confined && s.adminLevel ? s.adminLevel : undefined,
      lga, cluster, name, module: wantsAll ? undefined : scopedModule(req),
    })

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
 * GET /api/facilities/:id/dsd-sites - Registered DSD site names for a facility.
 * Used to populate the store-manager DSD dispatch dropdown so dispatched stock
 * always matches a real DSD account (no free-text orphan stock).
 */
router.get('/:id/dsd-sites', async (req, res) => {
  try {
    const { id } = req.params
    if (!validators.isUUID(id)) {
      return sendValidationError(res, 'Invalid facility id format', 'id')
    }
    const sites = await FacilityService.getDsdSites(id)
    res.json({
      success: true,
      data: sites,
      count: sites.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching DSD sites:', err)
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
