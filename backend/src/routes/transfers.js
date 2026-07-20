import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceTransferAccess, enforceTransferWrite, mayWriteTransferFacility, enforceCommoditySection, ownFacilityId, resolveListFacilityIds } from '../middleware/scope.js'
import { TransferService } from '../services/transferService.js'

const router = express.Router()

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
      date_field, from, to, notes_includes, limit = 1000, offset = 0
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
      categories: req.scope.sectionCategories,
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
      const okSend = l.sending_facility_id && await mayWriteTransferFacility(req, l.sending_facility_id)
      const okRecv = l.receiving_facility_id && await mayWriteTransferFacility(req, l.receiving_facility_id)
      if (!okSend && !okRecv) {
        return res.status(403).json({ success: false, error: 'Not authorized to create a transfer for another facility', code: 'FORBIDDEN' })
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
router.patch('/:id/assign', async (req, res) => {
  try {
    if (!req.body?.sending_facility_id) {
      return res.status(400).json({ success: false, error: 'sending_facility_id is required', code: 'MISSING_FIELDS' })
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
