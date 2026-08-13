import express from 'express'
import { WarehouseRequestService } from '../services/warehouseRequestService.js'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceModuleAccess, ownFacilityId, resolveListFacilityIds } from '../middleware/scope.js'

const router = express.Router()

// Facility-raised priced requests to the central warehouse (Essential Commodities only).
// Auth + scope are applied globally to /api (server.js). The WMS status callback is a
// separate service-token route under /hooks (see routes/warehouseRequestHooks.js).

const ok = (res, data) => res.json({ success: true, data, timestamp: new Date().toISOString() })
const fail = (res, status, error, code) => res.status(status).json({ success: false, error, code })

// Only a facility's own store manager raises/receives its requests.
function isFacilityStoreManager(req) {
  return req.scope.accessLevel === 'facility' && req.scope.facilityRole === 'store_manager'
}

/** GET /api/warehouse-requests — list (facility: own; admin: scoped). */
router.get('/', async (req, res) => {
  try {
    const { facility_id, facility_ids, status } = req.query
    const own = ownFacilityId(req)
    let rows
    if (own) {
      rows = await WarehouseRequestService.list({ facilityId: own, status })
    } else {
      const ids = await resolveListFacilityIds(req, 'transfers', facility_ids)
      if (Array.isArray(ids) && ids.length === 0) return ok(res, [])
      rows = await WarehouseRequestService.list({ facilityIds: ids === null ? null : ids, status })
    }
    ok(res, rows)
  } catch (err) {
    console.error('Error listing warehouse requests:', err)
    fail(res, 500, err.message, 'FETCH_ERROR')
  }
})

/** GET /api/warehouse-requests/:id */
router.get('/:id', async (req, res) => {
  try {
    if (!validators.isUUID(req.params.id)) return sendValidationError(res, 'Invalid id format', 'id')
    const reqRow = await WarehouseRequestService.getById(req.params.id)
    if (!reqRow) return fail(res, 404, 'Request not found', 'NOT_FOUND')
    const own = ownFacilityId(req)
    if (own && reqRow.facility_id !== own) return fail(res, 403, 'Not authorized for this request', 'FORBIDDEN')
    ok(res, reqRow)
  } catch (err) {
    console.error('Error fetching warehouse request:', err)
    fail(res, 500, err.message, 'FETCH_ERROR')
  }
})

/** POST /api/warehouse-requests — { items:[{ commodity_id, quantity }], notes } */
router.post('/', async (req, res) => {
  try {
    if (!(await enforceModuleAccess(req, res))) return
    if (req.scope.module !== 'essential') return fail(res, 400, 'Requests are only for the Essential Commodities module', 'WRONG_MODULE')
    if (!isFacilityStoreManager(req)) return fail(res, 403, 'Only a facility store manager can raise a request', 'FORBIDDEN')
    const facilityId = ownFacilityId(req)
    if (!facilityId) return fail(res, 403, 'No facility in scope', 'FORBIDDEN')

    const { items, notes, requestedBy, requesterPhone } = req.body || {}
    const norm = (items || []).map(i => ({ commodityId: i.commodity_id ?? i.commodityId, quantity: i.quantity, unitPrice: i.unit_price ?? i.unitPrice }))
    const created = await WarehouseRequestService.create({
      facilityId,
      items: norm,
      // The name the store manager typed on the request; falls back to the login
      // account only if none was supplied, so the warehouse has someone to call.
      requestedBy: (typeof requestedBy === 'string' && requestedBy.trim()) || req.user?.email || null,
      // Supplied by the facility raising the request — the warehouse calls this number if
      // anything on the order needs confirming before it goes out.
      requesterPhone: requesterPhone || null,
      notes,
    })
    ok(res, created)
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message, 'BAD_REQUEST')
    console.error('Error creating warehouse request:', err)
    fail(res, 500, err.message, 'CREATE_ERROR')
  }
})

/** PATCH /api/warehouse-requests/:id/resubmit — retry a deferred submit. */
router.patch('/:id/resubmit', async (req, res) => {
  try {
    if (!validators.isUUID(req.params.id)) return sendValidationError(res, 'Invalid id format', 'id')
    const reqRow = await WarehouseRequestService.getById(req.params.id)
    if (!reqRow) return fail(res, 404, 'Request not found', 'NOT_FOUND')
    const own = ownFacilityId(req)
    if (own && reqRow.facility_id !== own) return fail(res, 403, 'Not authorized for this request', 'FORBIDDEN')
    const updated = await WarehouseRequestService.resubmit(req.params.id)
    ok(res, updated)
  } catch (err) {
    console.error('Error resubmitting warehouse request:', err)
    fail(res, 500, err.message, 'SUBMIT_ERROR')
  }
})

/** PATCH /api/warehouse-requests/:id/cancel */
router.patch('/:id/cancel', async (req, res) => {
  try {
    if (!validators.isUUID(req.params.id)) return sendValidationError(res, 'Invalid id format', 'id')
    const reqRow = await WarehouseRequestService.getById(req.params.id)
    if (!reqRow) return fail(res, 404, 'Request not found', 'NOT_FOUND')
    const own = ownFacilityId(req)
    if (own && reqRow.facility_id !== own) return fail(res, 403, 'Not authorized for this request', 'FORBIDDEN')
    const updated = await WarehouseRequestService.cancel(req.params.id, { cancelledBy: req.user?.email })
    if (!updated) return fail(res, 409, 'Request can no longer be cancelled', 'CONFLICT')
    ok(res, updated)
  } catch (err) {
    console.error('Error cancelling warehouse request:', err)
    fail(res, 500, err.message, 'CANCEL_ERROR')
  }
})

/** PATCH /api/warehouse-requests/:id/receive — facility confirms receipt (credits stock). */
router.patch('/:id/receive', async (req, res) => {
  try {
    if (!validators.isUUID(req.params.id)) return sendValidationError(res, 'Invalid id format', 'id')
    const reqRow = await WarehouseRequestService.getById(req.params.id)
    if (!reqRow) return fail(res, 404, 'Request not found', 'NOT_FOUND')
    const own = ownFacilityId(req)
    if (own && reqRow.facility_id !== own) return fail(res, 403, 'Not authorized for this request', 'FORBIDDEN')
    if (!isFacilityStoreManager(req)) return fail(res, 403, 'Only a facility store manager can confirm receipt', 'FORBIDDEN')
    const updated = await WarehouseRequestService.confirmReceipt(req.params.id, { receivedBy: req.user?.email })
    ok(res, updated)
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message, 'CONFLICT')
    console.error('Error confirming receipt:', err)
    fail(res, 500, err.message, 'RECEIVE_ERROR')
  }
})

export default router
