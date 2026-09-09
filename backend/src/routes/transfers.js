import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceTransferAccess, enforceTransferWrite, mayWriteTransfer, mayWriteTransferFacility, enforceCommoditySection, ownFacilityId, resolveListFacilityIds, sectionFilter } from '../middleware/scope.js'
import { narrowGrantsToCategories } from '../constants/sections.js'
import { TransferService, TRANSFER_IN_GROUP_BY_KEYS } from '../services/transferService.js'
import { FacilityService } from '../services/facilityService.js'

const router = express.Router()

// The LGA bucket a facility falls into, matching the frontend's facilityGroupLabel:
// most facilities have an LGA; a cluster store and a state office get their own
// bucket. Two facilities are "in the same LGA" when they share a state and bucket.
const lgaBucket = f => f?.lga || (f?.cluster ? `${f.cluster} Cluster` : 'State Office')
const sameLga = (a, b) => !!a && !!b && a.state === b.state && lgaBucket(a) === lgaBucket(b)

// A "real" LGA — used for the request-source rule, where only facilities genuinely
// inside the requester's LGA are barred. State-office and cluster hubs have no LGA,
// so they are never "in" one and stay valid cross-LGA sources.
const realLga = f => (f && f.lga && String(f.lga).trim()) ? `${f.state}|${String(f.lga).trim()}` : null
const sameRealLga = (a, b) => { const x = realLga(a), y = realLga(b); return !!x && x === y }

// Auth (authMiddleware) and scope (attachScope) are applied globally to /api in
// server.js. Transfer access mirrors the RLS stock_transfer_log policies: a caller
// may read/mutate a transfer only if they are a party (sending or receiving
// facility) or a transfer admin (overall/state/cluster/lga, with state/lga narrowed).

// Run a transition after confirming the caller may act on the transfer. Loads the
// row first (404 if missing), enforces access (403 via enforceTransferAccess), then
// runs `fn`. `fn` returning null still maps to 404 (id/guard didn't match).
async function runTransition(req, res, fn, notFoundMsg = 'Transfer not found or not eligible') {
  const transfer = await TransferService.getTransferById(req.params.id)
  if (!transfer) {
    return res.status(404).json({ success: false, error: 'Transfer not found', code: 'TRANSFER_NOT_FOUND' })
  }
  // Transitions are writes — only a party or state_admin may act (read-only tiers barred).
  if (!(await enforceTransferWrite(req, res, transfer))) return
  const result = await fn()
  if (!result) {
    return res.status(404).json({ success: false, error: notFoundMsg, code: 'TRANSFER_NOT_FOUND' })
  }
  res.json({ success: true, data: result, timestamp: new Date().toISOString() })
}

/**
 * GET /api/transfers - List transfers (flexible filters)
 * Query: facility_id, direction (incoming|outgoing|any), status (comma list),
 *        section, date_field (initiated_at|resolved_at), from, to, notes_includes,
 *        limit, offset
 */
router.get('/', async (req, res) => {
  try {
    const {
      facility_id, facility_ids, direction = 'any', status, section,
      date_field, from, to, notes_includes, commodity_ids, limit = 1000, offset = 0
    } = req.query

    if (facility_id && !validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    // Scope the list (RLS transfer read policy):
    //  - facility users are pinned to their own facility (a different facility_id
    //    is rejected; an omitted one is filled in so they can't list everything).
    //  - admins may pass a single facility_id, or a facility_ids view-filter
    //    (intersected with their narrowed scope); omitting both spans their scope.
    const own = ownFacilityId(req)
    let scopedFacilityId = facility_id
    let scopedFacilityIds
    if (own) {
      if (facility_id && facility_id !== own) {
        return res.status(403).json({ success: false, error: 'Not authorized for this facility', code: 'FORBIDDEN' })
      }
      scopedFacilityId = own
    } else if (!facility_id) {
      const allowed = await resolveListFacilityIds(req, 'transfers', facility_ids)
      if (allowed !== null) scopedFacilityIds = allowed
    }

    // Empty scope = nothing visible. Guard before the service (which treats an
    // empty facilityIds array as "no filter" and would otherwise return everything).
    if (Array.isArray(scopedFacilityIds) && scopedFacilityIds.length === 0) {
      return res.json({ success: true, data: [], count: 0, timestamp: new Date().toISOString() })
    }

    const transfers = await TransferService.listTransfers({
      facilityId: scopedFacilityId,
      facilityIds: scopedFacilityIds,
      direction,
      statuses: status ? String(status).split(',').map(s => s.trim()).filter(Boolean) : null,
      section,
      dateField: date_field,
      from,
      to,
      notesIncludes: notes_includes,
      commodityIds: commodity_ids
        ? String(commodity_ids).split(',').map(s => s.trim()).filter(Boolean)
        : null,
      ...sectionFilter(req),
      limit: parseInt(limit),
      offset: parseInt(offset)
    })

    res.json({ success: true, data: transfers, count: transfers.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching transfers:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

/**
 * GET /api/transfers/summary - accepted transfers IN, aggregated server-side.
 *
 * Monitoring's "Total transfer-in" card and its drill-ins. Same contract as
 * /api/dispense/summary and /api/intake/summary — same allowlisted group_by shapes,
 * same { qty, txn } rows — so the dashboard can put all three side by side.
 * Scoped on the RECEIVING facility, since this counts stock arriving.
 *
 * MUST stay above GET /:id, or Express matches 'summary' as a transfer id.
 */
router.get('/summary', async (req, res) => {
  try {
    const { facility_id, facility_ids, from, to, commodity_ids, section,
            group_by, commodity_id, category, tz, direction } = req.query
    const commodityIds = commodity_ids ? String(commodity_ids).split(',').map(s => s.trim()).filter(Boolean) : null

    // 'in' = stock arriving (default, preserves the original behaviour), 'out' =
    // stock leaving. Scoping follows the direction, so a facility user asking for
    // 'out' sees what IT sent, never what was sent to it.
    const dir = direction ? String(direction) : 'in'
    if (dir !== 'in' && dir !== 'out') {
      return sendValidationError(res, `Unsupported direction. Must be one of: in | out`, 'direction')
    }

    const groupBy = group_by ? String(group_by) : 'commodity'
    if (!TRANSFER_IN_GROUP_BY_KEYS.includes(groupBy)) {
      return sendValidationError(res,
        `Unsupported group_by. Must be one of: ${TRANSFER_IN_GROUP_BY_KEYS.join(' | ')}`, 'group_by')
    }
    if (commodity_id && !validators.isUUID(commodity_id)) {
      return sendValidationError(res, 'Invalid commodity_id format', 'commodity_id')
    }
    if (tz && !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(String(tz))) {
      return sendValidationError(res, 'Invalid tz', 'tz')
    }

    // A `category` drill must stay inside the caller's section, never widen it.
    const tokenCats = req.scope.sectionCategories
    const grants = req.scope.sectionCommodityNames
    const viaGrant = !!category && narrowGrantsToCategories(grants, [String(category)]).length > 0
    if (category && Array.isArray(tokenCats) && !tokenCats.includes(String(category)) && !viaGrant) {
      return res.json({ success: true, data: [], count: 0, timestamp: new Date().toISOString() })
    }

    const base = {
      from, to, commodityIds, categories: tokenCats, commodityNames: grants, section,
      groupBy, commodityId: commodity_id || null, category: category || null, tz: tz || null,
      direction: dir,
    }

    // Scope on whichever side `direction` reports. A facility-level caller is pinned
    // to its own facility; an admin tier gets its jurisdiction, intersected with any
    // client facility_ids view-filter — the same resolution the transfer LIST uses.
    let rows
    if (facility_id) {
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      const allowed = await resolveListFacilityIds(req, 'transfers', facility_id)
      if (allowed !== null && !allowed.includes(facility_id)) {
        return res.status(403).json({ success: false, error: 'Not authorized for this facility', code: 'FORBIDDEN' })
      }
      rows = await TransferService.getTransferSummary(facility_id, base)
    } else {
      const facilityIds = await resolveListFacilityIds(req, 'transfers', facility_ids)
      rows = await TransferService.getTransferSummary(null, { ...base, facilityIds: facilityIds === null ? undefined : facilityIds })
    }
    res.json({ success: true, data: rows, count: rows.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching transfer summary:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

/**
 * GET /api/transfers/:id - Single transfer (with nested commodity)
 */
router.get('/:id', async (req, res) => {
  try {
    const transfer = await TransferService.getTransferById(req.params.id)
    if (!transfer) {
      return res.status(404).json({ success: false, error: 'Transfer not found', code: 'TRANSFER_NOT_FOUND' })
    }
    if (!(await enforceTransferAccess(req, res, transfer))) return
    res.json({ success: true, data: transfer, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching transfer:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

/**
 * POST /api/transfers - Create one or more transfer rows
 * Body: { lines: [...] } | [...] | { ...singleRow }
 * Each line carries the full row (sending/receiving ids+names, commodity, qty,
 * status, notes, …); the frontend encodes the type into notes + initial status.
 */
router.post('/', async (req, res) => {
  try {
    const body = req.body || {}
    const lines = Array.isArray(body) ? body : Array.isArray(body.lines) ? body.lines : [body]

    if (!lines.length || !lines[0]) {
      return res.status(400).json({ success: false, error: 'At least one transfer line is required', code: 'MISSING_FIELDS' })
    }
    // Only a party (facility user on either endpoint) or state_admin (endpoint in
    // their state) may create a transfer line. The read-only tiers (overall_admin,
    // state_viewer, cluster_admin, lga_admin) are barred. The line's commodity must
    // also be in the caller's section.
    for (const l of lines) {
      if (!l.commodity_id || l.quantity === undefined) {
        return res.status(400).json({ success: false, error: 'Each line requires commodity_id and quantity', code: 'INVALID_LINE_ITEM' })
      }
      if (!validators.isPositiveNumber(l.quantity)) {
        return sendValidationError(res, 'Line quantity must be a positive number', 'quantity')
      }
      // A transfer may not be CREATED already pointing at two different
      // facilities. The workflow this app has always used is: a facility submits
      // a REQUEST (receiving side only), an admin assigns the source via
      // PATCH /:id/assign, and only then does the assigned facility dispatch.
      // Creating both sides at once is the "external redistribution send" path,
      // whose form is hard-disabled in both the pharmacy and lab UIs
      // ("intentionally disabled: this module is view/print only"), so nothing
      // legitimate reaches this. Closing it here stops the API permitting what
      // the product forbids.
      //
      // Deliberately narrow — it blocks ONLY the two-different-facilities shape.
      // The three live creation paths all still pass:
      //   request  : sending null, receiving own facility
      //   internal : sending === receiving (Store -> Dispensary, same facility)
      //   DSD/SDP  : sending own facility, receiving null
      if (l.sending_facility_id && l.receiving_facility_id
          && l.sending_facility_id !== l.receiving_facility_id) {
        return res.status(403).json({
          success: false,
          error: 'A transfer cannot be created with both a sending and a receiving facility. Submit a request; an administrator assigns the source facility.',
          code: 'FORBIDDEN',
        })
      }

      const okSend = l.sending_facility_id && await mayWriteTransferFacility(req, l.sending_facility_id)
      const okRecv = l.receiving_facility_id && await mayWriteTransferFacility(req, l.receiving_facility_id)
      if (!okSend && !okRecv) {
        return res.status(403).json({ success: false, error: 'Not authorized to create a transfer for another facility', code: 'FORBIDDEN' })
      }
      // External redistribution (a real facility→facility move, both sides set and
      // different) is limited to facilities in the SAME LGA — a facility may push
      // surplus within its LGA, but stock crossing LGA boundaries goes through the
      // request flow instead. Internal moves (same facility, store→dispensary/DSD/SDP)
      // and requests (no sending facility yet) are unaffected.
      if (l.sending_facility_id && l.receiving_facility_id && l.sending_facility_id !== l.receiving_facility_id) {
        const [sf, rf] = await Promise.all([
          FacilityService.getFacilityById(l.sending_facility_id),
          FacilityService.getFacilityById(l.receiving_facility_id),
        ])
        if (!sameLga(sf, rf)) {
          return res.status(403).json({ success: false, error: 'External redistribution is limited to facilities in the same LGA. To move stock across LGAs, use the request flow.', code: 'CROSS_LGA_TRANSFER' })
        }
      }
      if (!(await enforceCommoditySection(req, res, l.commodity_id))) return
    }

    const created = await TransferService.createTransfers(lines)
    res.status(201).json({ success: true, data: created, count: created.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error creating transfer:', err)
    res.status(500).json({ success: false, error: err.message, code: 'CREATE_ERROR' })
  }
})

/** PATCH /api/transfers/:id/dispatch - approve+dispatch external (decrements sender store) */
router.patch('/:id/dispatch', async (req, res) => {
  try {
    await runTransition(req, res, () => TransferService.dispatch(req.params.id, req.body || {}))
  } catch (err) {
    console.error('Error dispatching transfer:', err)
    res.status(500).json({ success: false, error: err.message, code: 'DISPATCH_ERROR' })
  }
})

/** PATCH /api/transfers/:id/assign - admin assigns a source facility */
/**
 * PATCH /api/transfers/dispatch-batch — dispatch several pending transfers at once.
 * Body: { approved_by, carrier, items: [{ id, quantity, lots?, carrier? }] }
 *
 * MUST stay above '/:id'.
 */
router.patch('/dispatch-batch', async (req, res) => {
  try {
    const { approved_by, carrier, items } = req.body || {}
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Select at least one transfer', code: 'MISSING_FIELDS' })
    }
    // Per-row write access, checked before anything moves — same reasoning as
    // assign-batch: a bulk endpoint must not reach past the caller's own facility.
    for (const item of items) {
      const transfer = await TransferService.getTransferById(item.id)
      if (!transfer) {
        return res.status(404).json({ success: false, error: `Transfer ${item.id} not found`, code: 'TRANSFER_NOT_FOUND' })
      }
      if (!(await mayWriteTransfer(req, transfer))) {
        return res.status(403).json({ success: false, error: 'Not authorized for one of the selected transfers', code: 'FORBIDDEN' })
      }
    }
    const dispatched = await TransferService.dispatchBatch({ items, approved_by, carrier })
    res.json({ success: true, data: dispatched, count: dispatched.length, timestamp: new Date().toISOString() })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message, code: 'DISPATCH_ERROR' })
    console.error('Error dispatching transfers in batch:', err)
    res.status(500).json({ success: false, error: err.message, code: 'DISPATCH_ERROR' })
  }
})

/**
 * PATCH /api/transfers/assign-batch — assign one source to several pending requests.
 * Body: { sending_facility_id, sending_facility_name?, reviewed_by, items: [{ id, quantity }] }
 *
 * MUST stay above '/:id' (declared further down), which would otherwise capture
 * 'assign-batch' as an id.
 */
router.patch('/assign-batch', async (req, res) => {
  try {
    const { sending_facility_id, sending_facility_name, reviewed_by, items } = req.body || {}
    if (!sending_facility_id) {
      return res.status(400).json({ success: false, error: 'sending_facility_id is required', code: 'MISSING_FIELDS' })
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Select at least one request', code: 'MISSING_FIELDS' })
    }

    // Write access is checked per ROW before anything is written — a bulk endpoint must
    // not become a way to touch a request outside the caller's jurisdiction or section.
    for (const item of items) {
      const transfer = await TransferService.getTransferById(item.id)
      if (!transfer) {
        return res.status(404).json({ success: false, error: `Request ${item.id} not found`, code: 'TRANSFER_NOT_FOUND' })
      }
      if (!(await mayWriteTransfer(req, transfer))) {
        return res.status(403).json({ success: false, error: 'Not authorized for one of the selected requests', code: 'FORBIDDEN' })
      }
    }
    // The source must also be a facility this caller may act for.
    if (!(await mayWriteTransferFacility(req, sending_facility_id))) {
      return res.status(403).json({ success: false, error: 'Not authorized for that source facility', code: 'FORBIDDEN' })
    }

    // A request is fulfilled from OUTSIDE the requesting facility's LGA (within-LGA
    // moves go through external redistribution). Reject a source sharing any request's
    // LGA.
    const srcFac = await FacilityService.getFacilityById(sending_facility_id)
    for (const item of items) {
      const transfer = await TransferService.getTransferById(item.id)
      const reqFac = await FacilityService.getFacilityById(transfer.receiving_facility_id)
      if (sameRealLga(reqFac, srcFac)) {
        return res.status(403).json({ success: false, error: 'A request must be fulfilled from a facility outside the requesting facility\'s LGA.', code: 'SAME_LGA_SOURCE' })
      }
    }

    const assigned = await TransferService.assignSourceBulk({
      items, sendingFacilityId: sending_facility_id,
      sendingFacilityName: sending_facility_name, reviewedBy: reviewed_by,
    })
    res.json({ success: true, data: assigned, count: assigned.length, timestamp: new Date().toISOString() })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message, code: 'ASSIGN_ERROR' })
    console.error('Error assigning transfers in batch:', err)
    res.status(500).json({ success: false, error: err.message, code: 'ASSIGN_ERROR' })
  }
})

router.patch('/:id/assign', async (req, res) => {
  try {
    if (!req.body?.sending_facility_id) {
      return res.status(400).json({ success: false, error: 'sending_facility_id is required', code: 'MISSING_FIELDS' })
    }
    // A request is fulfilled from OUTSIDE the requesting facility's LGA.
    const transfer = await TransferService.getTransferById(req.params.id)
    if (transfer) {
      const [reqFac, srcFac] = await Promise.all([
        FacilityService.getFacilityById(transfer.receiving_facility_id),
        FacilityService.getFacilityById(req.body.sending_facility_id),
      ])
      if (sameRealLga(reqFac, srcFac)) {
        return res.status(403).json({ success: false, error: 'A request must be fulfilled from a facility outside the requesting facility\'s LGA.', code: 'SAME_LGA_SOURCE' })
      }
    }
    await runTransition(req, res, () => TransferService.assignSource(req.params.id, req.body))
  } catch (err) {
    console.error('Error assigning transfer source:', err)
    res.status(500).json({ success: false, error: err.message, code: 'ASSIGN_ERROR' })
  }
})

/** PATCH /api/transfers/:id/accept - receiver accepts (credits receiver store; no intake_log — the transfer already records the receipt) */
router.patch('/:id/accept', async (req, res) => {
  try {
    if (!req.body?.received_by) {
      return res.status(400).json({ success: false, error: 'received_by is required', code: 'MISSING_FIELDS' })
    }
    await runTransition(req, res, () => TransferService.accept(req.params.id, req.body))
  } catch (err) {
    console.error('Error accepting transfer:', err)
    res.status(500).json({ success: false, error: err.message, code: 'ACCEPT_ERROR' })
  }
})

/** PATCH /api/transfers/:id/dispute - receiver disputes (optional facility_id guard) */
router.patch('/:id/dispute', async (req, res) => {
  try {
    await runTransition(
      req, res,
      () => TransferService.dispute(req.params.id, req.body || {}),
      'Transfer not found or not owned by this facility'
    )
  } catch (err) {
    console.error('Error disputing transfer:', err)
    res.status(500).json({ success: false, error: err.message, code: 'DISPUTE_ERROR' })
  }
})

/** PATCH /api/transfers/:id/cancel - cancel/reject (no stock movement) */
router.patch('/:id/cancel', async (req, res) => {
  try {
    await runTransition(req, res, () => TransferService.cancel(req.params.id, req.body || {}))
  } catch (err) {
    console.error('Error cancelling transfer:', err)
    res.status(500).json({ success: false, error: err.message, code: 'CANCEL_ERROR' })
  }
})

/** PATCH /api/transfers/:id/approve-internal - store→dispensary move */
router.patch('/:id/approve-internal', async (req, res) => {
  try {
    if (!req.body?.approved_by) {
      return res.status(400).json({ success: false, error: 'approved_by is required', code: 'MISSING_FIELDS' })
    }
    await runTransition(req, res, () => TransferService.approveInternal(req.params.id, req.body))
  } catch (err) {
    console.error('Error approving internal transfer:', err)
    res.status(err.status || 500).json({ success: false, error: err.message, code: err.status === 409 ? 'INSUFFICIENT_STOCK' : 'APPROVE_ERROR' })
  }
})

/** PATCH /api/transfers/:id/approve-dsd - approve SDP/DSD request → dispatched */
router.patch('/:id/approve-dsd', async (req, res) => {
  try {
    if (!req.body?.approved_by) {
      return res.status(400).json({ success: false, error: 'approved_by is required', code: 'MISSING_FIELDS' })
    }
    await runTransition(req, res, () => TransferService.approveDsd(req.params.id, req.body))
  } catch (err) {
    console.error('Error approving DSD/SDP transfer:', err)
    res.status(err.status || 500).json({ success: false, error: err.message, code: err.status === 409 ? 'INSUFFICIENT_STOCK' : 'APPROVE_ERROR' })
  }
})

/** PATCH /api/transfers/:id/receive - site confirms receipt (credits sdp_stock/dsd_stock) */
router.patch('/:id/receive', async (req, res) => {
  try {
    if (!req.body?.received_by) {
      return res.status(400).json({ success: false, error: 'received_by is required', code: 'MISSING_FIELDS' })
    }
    await runTransition(req, res, () => TransferService.receive(req.params.id, req.body))
  } catch (err) {
    console.error('Error confirming transfer receipt:', err)
    res.status(500).json({ success: false, error: err.message, code: 'RECEIVE_ERROR' })
  }
})

/**
 * PATCH /api/transfers/:id - Metadata-only update (no stock side-effects)
 * Body: any of { status, quantity, qty_requested, notes, dispute_note, resolved_by, resolved_at }
 * For edit-quantity, dismiss, mark-fulfilled, notes edits.
 */
router.patch('/:id', async (req, res) => {
  try {
    await runTransition(req, res, () => TransferService.updateTransfer(req.params.id, req.body || {}))
  } catch (err) {
    console.error('Error updating transfer:', err)
    res.status(500).json({ success: false, error: err.message, code: 'UPDATE_ERROR' })
  }
})

/** DELETE /api/transfers/:id */
router.delete('/:id', async (req, res) => {
  try {
    const transfer = await TransferService.getTransferById(req.params.id)
    if (!transfer) {
      return res.status(404).json({ success: false, error: 'Transfer not found', code: 'TRANSFER_NOT_FOUND' })
    }
    if (!(await enforceTransferWrite(req, res, transfer))) return

    const deleted = await TransferService.deleteTransfer(req.params.id)
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Transfer not found', code: 'TRANSFER_NOT_FOUND' })
    }
    res.json({ success: true, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error deleting transfer:', err)
    res.status(500).json({ success: false, error: err.message, code: 'DELETE_ERROR' })
  }
})

export default router
