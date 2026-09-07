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
const isCatalogueManager = req =>
  req.scope?.accessLevel === 'overall_admin' || req.scope?.isAdmin === true ||
  req.scope?.accessLevel === 'essential_admin'

// The modules a catalogue manager may create items in. The catalogue is ONE
// shared table across modules, so "may add items" is not the whole question —
// an essential_admin adding an item to the `hiv` module would be writing another
// programme's master data through a shared endpoint.
//
// null = unrestricted (overall_admin, the national catalogue owner).
const catalogueModulesFor = req =>
  req.scope?.accessLevel === 'essential_admin' ? ['essential'] : null

// Reject a create whose module memberships fall outside the caller's remit.
// Returns true when the request may proceed.
function enforceCatalogueModules(req, res, modules) {
  const allowed = catalogueModulesFor(req)
  if (!allowed) return true
  const outside = modules.filter(m => !allowed.includes(m))
  if (outside.length) {
    res.status(403).json({
      success: false, code: 'FORBIDDEN',
      error: `You may only add catalogue items to: ${allowed.join(', ')}.`,
    })
    return false
  }
  return true
}

router.get('/', async (req, res) => {
  try {
    const { module, active, q } = req.query
    const commodities = await CommodityService.getCommodities({
      module: module || undefined,
      activeOnly: active === 'true' || active === '1',
      q: q || undefined,
    })

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

router.get('/modules', async (_req, res) => {
  try { res.json({ success: true, data: await CommodityService.getModules() }) }
  catch (err) { res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' }) }
})

router.get('/categories', async (req, res) => {
  try { res.json({ success: true, data: await CommodityService.getCategories(req.query.module || null) }) }
  catch (err) { res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' }) }
})

router.post('/categories', async (req, res) => {
  try {
    if (!isCatalogueManager(req)) return res.status(403).json({ success: false, error: 'Catalogue manager access required', code: 'FORBIDDEN' })
    const { module, name, code, parent_id, sort_order } = req.body || {}
    if (!module || !name || !String(name).trim()) return sendValidationError(res, 'module and name are required', 'name')
    if (!enforceCatalogueModules(req, res, [module])) return
    if (parent_id && !validators.isUUID(parent_id)) return sendValidationError(res, 'Invalid parent_id', 'parent_id')
    const category = await CommodityService.createCategory({ module, name: String(name).trim(), code, parentId: parent_id, sortOrder: sort_order })
    res.status(201).json({ success: true, data: category, timestamp: new Date().toISOString() })
  } catch (err) { res.status(400).json({ success: false, error: err.message, code: 'CREATE_ERROR' }) }
})

router.post('/', async (req, res) => {
  try {
    if (!isCatalogueManager(req)) return res.status(403).json({ success: false, error: 'Catalogue manager access required', code: 'FORBIDDEN' })
    const { name, item_type, item_code, description, is_active, memberships } = req.body || {}
    if (!name || !String(name).trim()) return sendValidationError(res, 'name is required', 'name')
    if (!Array.isArray(memberships) || memberships.length === 0) return sendValidationError(res, 'At least one module membership is required', 'memberships')
    const seen = new Set()
    for (const membership of memberships) {
      if (!membership?.module || seen.has(membership.module)) return sendValidationError(res, 'Each membership must have a unique module', 'memberships')
      seen.add(membership.module)
      if (membership.category_id && !validators.isUUID(membership.category_id)) return sendValidationError(res, 'Invalid category_id', 'memberships')
    }
    if (!enforceCatalogueModules(req, res, [...seen])) return
    const commodity = await CommodityService.createCommodity({
      name: String(name).trim(), itemType: item_type || 'commodity', itemCode: item_code,
      description, isActive: is_active !== false, memberships,
    })
    res.status(201).json({ success: true, data: commodity, timestamp: new Date().toISOString() })
  } catch (err) { res.status(400).json({ success: false, error: err.message, code: 'CREATE_ERROR' }) }
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
