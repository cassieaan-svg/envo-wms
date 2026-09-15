import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceFacilityRead, enforceFacilityWrite, resolveListFacilityIds, enforceCommoditySection, sectionFilter } from '../middleware/scope.js'
import { narrowGrantsToCategories } from '../constants/sections.js'
import { LogService, INTAKE_GROUP_BY_KEYS } from '../services/logService.js'
import { StockService } from '../services/stockService.js'
import { IdempotencyService } from '../services/idempotencyService.js'

const router = express.Router()

// Auth + scope applied globally to /api (server.js). intake_log RLS: read =
// own facility or read-admin; write(INSERT) = own facility or is_admin only.

/**
 * POST /api/intake - Record intake operation
 * Body: { facility_id, commodity_id, quantity, supplier_source, batch_number (optional),
 *         expiry_date (optional), delivery_note_ref (optional), condition_on_arrival (optional),
 *         received_by, received_at (optional), notes (optional), section,
 *         client_txn_id (optional today) }
 *
 * client_txn_id follows the same contract as POST /api/dispense — optional for the
 * current online-only frontend, required by the offline-capable client's own queue
 * contract (see docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms sibling
 * project).
 */
router.post('/', async (req, res) => {
  try {
    const {
      facility_id,
      commodity_id,
      quantity,
      supplier_source,
      batch_number,
      expiry_date,
      delivery_note_ref,
      condition_on_arrival,
      received_by,
      received_at,
      notes,
      section,
      client_txn_id
    } = req.body

    // Validate required fields. batch_number and expiry_date are required here
    // too (not just in the form): an intake with no lot/expiry can't be expiry-
    // checked, and this is the boundary a direct API/import call goes through.
    if (!facility_id || !commodity_id || quantity === undefined || !received_by || !batch_number || !expiry_date) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: facility_id, commodity_id, quantity, received_by, batch_number, expiry_date',
        code: 'MISSING_FIELDS'
      })
    }

    let validatedTxnId
    try {
      validatedTxnId = IdempotencyService.validate(client_txn_id)
    } catch (idErr) {
      return sendValidationError(res, idErr.message, 'client_txn_id')
    }

    // Enforce facility scoping (intake_log write policy)
    if (!(await enforceFacilityWrite(req, res, facility_id, 'intake_log'))) return
    if (!(await enforceCommoditySection(req, res, commodity_id))) return

    // Validate facility exists
    const facilityExists = await StockService.facilityExists(facility_id)
    if (!facilityExists) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
        code: 'FACILITY_NOT_FOUND'
      })
    }

    // Validate commodity exists
    const commodityExists = await StockService.commodityExists(commodity_id)
    if (!commodityExists) {
      return res.status(404).json({
        success: false,
        error: 'Commodity not found',
        code: 'COMMODITY_NOT_FOUND'
      })
    }

    // Validate quantity is positive
    if (!validators.isPositiveNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be a positive number', 'quantity')
    }

    // Validate received_at if provided. Past dates are allowed (a delivery can be
    // recorded after the fact), but not future ones — you can't receive stock that
    // hasn't arrived. Compared on the Lagos calendar day so a late-evening entry
    // isn't wrongly rejected as "tomorrow" in UTC.
    if (received_at && !validators.isValidDate(received_at)) {
      return sendValidationError(res, 'received_at must be a valid date', 'received_at')
    }
    if (received_at) {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
      const day = new Date(received_at).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
      if (day > today) {
        return sendValidationError(res, 'received_at cannot be in the future', 'received_at')
      }
    }

    // Validate expiry_date: correct format AND a plausible year (rejects a fumbled
    // "0001-01-01" the date picker can produce, which format-only checks let pass).
    if (!validators.isValidISODate(expiry_date)) {
      return sendValidationError(res, 'expiry_date must be in YYYY-MM-DD format', 'expiry_date')
    }
    if (!validators.isPlausibleExpiry(expiry_date)) {
      return sendValidationError(res, 'expiry_date must be in the future — cannot receive already-expired stock', 'expiry_date')
    }

    const intake = await LogService.recordIntake({
      facility_id,
      commodity_id,
      quantity: parseInt(quantity),
      supplier_source,
      batch_number,
      expiry_date,
      delivery_note_ref,
      condition_on_arrival,
      received_by,
      received_at,
      notes,
      section,
      client_txn_id: validatedTxnId,
      actor_user_id: req.user?.sub ?? null
    })

    res.status(201).json({
      success: true,
      data: intake,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    const status = err.status === 409 ? 409 : 500
    if (status === 500) console.error('Error recording intake:', err)
    res.status(status).json({
      success: false,
      error: err.message,
      code: status === 409 ? 'INTAKE_CONFLICT' : 'INTAKE_ERROR'
    })
  }
})

/**
 * GET /api/intake - Get intake history
 * Query params: facility_id (required), supplier_source (optional), date (optional, YYYY-MM-DD)
 */
router.get('/', async (req, res) => {
  try {
    const {
      facility_id, facility_ids, supplier_source,
      date, from, to, commodity_ids, section,
      expiry_from, expiry_to, has_quantity, limit = 1000, offset = 0
    } = req.query

    if (date && !validators.isValidISODate(date)) {
      return sendValidationError(res, 'date must be in YYYY-MM-DD format', 'date')
    }
    const commodityIds = commodity_ids ? String(commodity_ids).split(',').map(s => s.trim()).filter(Boolean) : null
    const base = {
      supplier_source, date, from, to, commodityIds, ...sectionFilter(req), section,
      expiryFrom: expiry_from, expiryTo: expiry_to,
      hasQuantity: has_quantity === 'true' || has_quantity === '1',
      limit: parseInt(limit), offset: parseInt(offset)
    }

    let history
    if (facility_id) {
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      if (!(await enforceFacilityRead(req, res, facility_id, 'intake_log'))) return
      history = await LogService.getIntakeHistory(facility_id, base)
    } else {
      const facilityIds = await resolveListFacilityIds(req, 'intake_log', facility_ids)
      history = await LogService.getIntakeHistory(null, { ...base, facilityIds: facilityIds === null ? undefined : facilityIds })
    }

    res.json({
      success: true,
      data: history,
      count: history.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching intake history:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * GET /api/intake/summary - intake aggregated server-side.
 *
 * The receiving-side mirror of GET /api/dispense/summary, and deliberately the same
 * contract: the same allowlisted `group_by` shapes (minus the AMC-only ones — see
 * INTAKE_GROUP_BY_KEYS), the same scope/section enforcement, and the same
 * { qty, txn } row shape. Monitoring's "Units received" card and its commodity /
 * facility drill-ins read this, so a received figure is always scoped exactly like
 * the consumed figure beside it.
 *
 * Query params: facility_id | facility_ids | state / lga, from, to, commodity_ids,
 * section, group_by, commodity_id / category (drill-in narrowing), tz.
 */
router.get('/summary', async (req, res) => {
  try {
    const { facility_id, facility_ids, from, to, commodity_ids, section,
            group_by, commodity_id, category, tz, supplier } = req.query
    const commodityIds = commodity_ids ? String(commodity_ids).split(',').map(s => s.trim()).filter(Boolean) : null
    if (supplier && !['ghsc', 'other'].includes(String(supplier))) {
      return sendValidationError(res, "supplier must be 'ghsc' or 'other'", 'supplier')
    }

    const groupBy = group_by ? String(group_by) : 'commodity'
    if (!INTAKE_GROUP_BY_KEYS.includes(groupBy)) {
      return sendValidationError(res,
        `Unsupported group_by. Must be one of: ${INTAKE_GROUP_BY_KEYS.join(' | ')}`, 'group_by')
    }
    if (commodity_id && !validators.isUUID(commodity_id)) {
      return sendValidationError(res, 'Invalid commodity_id format', 'commodity_id')
    }
    // tz reaches SQL as a bind parameter, never interpolated; still validated so a
    // bad zone is a clear 400 instead of a Postgres error surfacing as a 500.
    if (tz && !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(String(tz))) {
      return sendValidationError(res, 'Invalid tz', 'tz')
    }

    // A `category` drill must stay inside the caller's section, never widen it. A
    // category the caller only reaches through an individual grant is still allowed
    // through — the section filter in SQL then narrows it to the granted commodity
    // alone, so this cannot return the rest of that category.
    const tokenCats = req.scope.sectionCategories
    const grants = req.scope.sectionCommodityNames
    const viaGrant = !!category && narrowGrantsToCategories(grants, [String(category)]).length > 0
    if (category && Array.isArray(tokenCats) && !tokenCats.includes(String(category)) && !viaGrant) {
      return res.json({ success: true, data: [], count: 0, timestamp: new Date().toISOString() })
    }

    const base = {
      from, to, commodityIds, categories: tokenCats, commodityNames: grants, section,
      groupBy, commodityId: commodity_id || null, category: category || null, tz: tz || null,
      supplier: supplier || null,
    }
    let rows
    if (facility_id) {
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      if (!(await enforceFacilityRead(req, res, facility_id, 'intake_log'))) return
      rows = await LogService.getIntakeSummary(facility_id, base)
    } else {
      const facilityIds = await resolveListFacilityIds(req, 'intake_log', facility_ids)
      rows = await LogService.getIntakeSummary(null, { ...base, facilityIds: facilityIds === null ? undefined : facilityIds })
    }
    res.json({ success: true, data: rows, count: rows.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching intake summary:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

/**
 * PATCH /api/intake/:id - Edit an intake record (metadata only; client reconciles
 * stock). Scoped to the row's facility (own facility or admin).
 */
router.patch('/:id', async (req, res) => {
  try {
    const row = await LogService.getLogRow('intake', req.params.id)
    if (!row) return res.status(404).json({ success: false, error: 'Intake record not found', code: 'NOT_FOUND' })
    if (!(await enforceFacilityWrite(req, res, row.facility_id, 'intake_log'))) return
    if (!(await enforceCommoditySection(req, res, row.commodity_id))) return

    const updated = await LogService.updateLog('intake', req.params.id, req.body || {})
    res.json({ success: true, data: updated, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error updating intake record:', err)
    res.status(500).json({ success: false, error: err.message, code: 'UPDATE_ERROR' })
  }
})

export default router
