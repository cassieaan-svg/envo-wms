import express from 'express'
import { WarehouseRequestService } from '../services/warehouseRequestService.js'
import { FacilityDebtService } from '../services/facilityDebtService.js'
import { validators, sendValidationError } from '../middleware/validation.js'
import { IdempotencyService } from '../services/idempotencyService.js'
import { enforceModuleAccess, ownFacilityId, resolveListFacilityIds, enforceFacilityRead } from '../middleware/scope.js'

const router = express.Router()

// Facility-raised priced requests to the central warehouse (Essential Commodities only).
// Auth + scope are applied globally to /api (server.js). The WMS status callback is a
// separate service-token route under /hooks (see routes/warehouseRequestHooks.js).

const ok = (res, data) => res.json({ success: true, data, timestamp: new Date().toISOString() })
const fail = (res, status, error, code) => res.status(status).json({ success: false, error, code })

// Every route here is Essential-only, so the module gate belongs on the router rather
// than on individual handlers. It used to sit on POST alone, which left the reads
// ungated: an admin with no Essential grant could still list and open any request in
// its jurisdiction, and a caller working in HIV could read Essential data through it.
router.use(async (req, res, next) => {
  if (req.scope.module !== 'essential') {
    return fail(res, 400, 'Warehouse requests belong to the Essential Commodities module', 'WRONG_MODULE')
  }
  if (!(await enforceModuleAccess(req, res))) return
  next()
})

// Only a facility's own store manager raises/receives its requests.
function isFacilityStoreManager(req) {
  return req.scope.accessLevel === 'facility' && req.scope.facilityRole === 'store_manager'
}

// Guard a state-changing action on one request. Every mutation here belongs to the
// facility that raised it, so this demands facility ownership rather than merely
// checking it when present.
//
// The previous form was `if (own && row.facility_id !== own)`. For an admin `own` is
// null, so the condition short-circuited and the check was skipped ENTIRELY — any
// admin tier, including an LGA admin whose jurisdiction is a different LGA, could
// cancel or resubmit any facility's request anywhere in the country. Admin access to
// Essential is oversight-only, so the answer is to refuse admins outright, not to
// scope them: reads go through enforceFacilityRead, writes stay with the facility.
function enforceOwnRequest(req, res, row) {
  const own = ownFacilityId(req)
  if (!own || row.facility_id !== own) {
    fail(res, 403, 'Not authorized for this request', 'FORBIDDEN')
    return false
  }
  return true
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

/**
 * GET /api/warehouse-requests/spend — what facilities have bought, aggregated.
 * Query: group_by=facility|lga|state|commodity|status|month, from, to, status, facility_ids
 *
 * MUST stay above '/:id'. Express matches in order, and '/:id' would otherwise capture
 * 'spend' and reject it as a malformed UUID.
 */
router.get('/spend', async (req, res) => {
  try {
    const { group_by, from, to, status, facility_ids } = req.query
    // Same scoping as the list: a facility sees only itself, an admin only its
    // jurisdiction, and a client-supplied facility_ids can narrow but never widen.
    const own = ownFacilityId(req)
    const ids = own ? [own] : await resolveListFacilityIds(req, 'transfers', facility_ids)
    if (Array.isArray(ids) && ids.length === 0) return ok(res, [])
    // Read from the WMS: spend must cover direct dispatches too, not only the orders
    // EnVo raised. See FacilityDebtService.spend.
    const rows = await FacilityDebtService.spend({
      facilityIds: ids === null ? null : ids,
      groupBy: group_by || 'facility',
      from: from || null, to: to || null, scheme: status || null,
    })
    ok(res, rows)
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message, 'BAD_REQUEST')
    console.error('Error building spend report:', err)
    fail(res, 500, err.message, 'FETCH_ERROR')
  }
})

/**
 * GET /api/warehouse-requests/balances — what facilities owe the central store.
 *
 * Scoped exactly like the list: a facility login sees only its own balance, an admin
 * only its jurisdiction. MUST stay above '/:id' — Express matches in order and '/:id'
 * would capture 'balances' and reject it as a malformed UUID.
 */
router.get('/balances', async (req, res) => {
  try {
    const own = ownFacilityId(req)
    const ids = own ? [own] : await resolveListFacilityIds(req, 'transfers', req.query.facility_ids)
    if (Array.isArray(ids) && ids.length === 0) return ok(res, [])
    ok(res, await FacilityDebtService.forFacilities(ids))
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message, 'WMS_UNAVAILABLE')
    console.error('Error fetching balances:', err)
    fail(res, 500, err.message, 'FETCH_ERROR')
  }
})

/**
 * GET /api/warehouse-requests/balances/:facility_id/orders — the orders behind a
 * facility's balance, including direct dispatches. Above '/:id' for the same reason.
 */
router.get('/balances/:facility_id/orders', async (req, res) => {
  try {
    const facilityId = req.params.facility_id
    if (!validators.isUUID(facilityId)) return sendValidationError(res, 'Invalid id format', 'facility_id')
    // Jurisdiction applies: a facility login may only open its own, an admin only
    // facilities inside its state/LGA/cluster.
    if (!(await enforceFacilityRead(req, res, facilityId, 'transfers'))) return
    ok(res, await FacilityDebtService.ordersFor(facilityId))
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message, 'WMS_UNAVAILABLE')
    console.error('Error fetching facility orders:', err)
    fail(res, 500, err.message, 'FETCH_ERROR')
  }
})

/** GET /api/warehouse-requests/:id */
router.get('/:id', async (req, res) => {
  try {
    if (!validators.isUUID(req.params.id)) return sendValidationError(res, 'Invalid id format', 'id')
    const reqRow = await WarehouseRequestService.getById(req.params.id)
    if (!reqRow) return fail(res, 404, 'Request not found', 'NOT_FOUND')
    // Reads are open to oversight, but jurisdiction still applies: enforceFacilityRead
    // narrows an admin to its own state/LGA/cluster and pins a facility login to its
    // own rows. 'transfers' is the right table here — warehouse requests are scoped
    // like redistribution, and the list endpoint above already resolves against it.
    if (!(await enforceFacilityRead(req, res, reqRow.facility_id, 'transfers'))) return
    ok(res, reqRow)
  } catch (err) {
    console.error('Error fetching warehouse request:', err)
    fail(res, 500, err.message, 'FETCH_ERROR')
  }
})

/**
 * POST /api/warehouse-requests — { items:[{ commodity_id, quantity }], notes,
 * client_txn_id (optional today) }
 *
 * client_txn_id follows the same contract as dispense/intake/adjustments/transfers:
 * optional for the current online-only frontend, required by the offline-capable
 * client's own queue contract. This only covers the device-to-EnVo leg — reaching
 * the actual warehouse still depends on connectivity to WMS, unchanged, via the
 * outbox this always had (see docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the
 * envo-wms sibling project).
 */
router.post('/', async (req, res) => {
  try {
    // Module + grant already enforced by the router-level gate above.
    if (!isFacilityStoreManager(req)) return fail(res, 403, 'Only a facility store manager can raise a request', 'FORBIDDEN')
    const facilityId = ownFacilityId(req)
    if (!facilityId) return fail(res, 403, 'No facility in scope', 'FORBIDDEN')

    let validatedTxnId
    try {
      validatedTxnId = IdempotencyService.validate(req.body?.client_txn_id)
    } catch (idErr) {
      return sendValidationError(res, idErr.message, 'client_txn_id')
    }

    const { items, notes, requestedBy, requesterPhone, scheme } = req.body || {}
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
      requestedScheme: scheme ?? null,
      notes,
      clientTxnId: validatedTxnId,
      actorUserId: req.user?.sub ?? null,
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
    if (!enforceOwnRequest(req, res, reqRow)) return
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
    if (!enforceOwnRequest(req, res, reqRow)) return
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
    if (!enforceOwnRequest(req, res, reqRow)) return
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
