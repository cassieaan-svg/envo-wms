import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceFacilityRead, enforceFacilityWrite, resolveListFacilityIds, enforceCommoditySection, sectionFilter } from '../middleware/scope.js'
import { narrowGrantsToCategories } from '../constants/sections.js'
import { LogService, DISPENSE_GROUP_BY_KEYS } from '../services/logService.js'
import { StockService } from '../services/stockService.js'
import { IdempotencyService } from '../services/idempotencyService.js'

const router = express.Router()

// Auth + scope applied globally to /api (server.js). dispense_log RLS: read =
// own facility or read-admin; write(INSERT) = own facility or is_admin only.

/**
 * POST /api/dispense - Record dispense operation
 * Body: { facility_id, commodity_id, quantity, dispensed_by, dispensed_at (optional),
 *         notes (optional), dsd_site_name or sdp_name (optional), section,
 *         client_txn_id (optional today) }
 *
 * client_txn_id is optional for now — the current online-only frontend doesn't send
 * one, and this endpoint keeps working exactly as before when it's absent. The
 * offline-capable client queues this write locally and MUST supply one (a retried
 * queued entry with no id would double-dispense on the first flaky reconnect); that
 * requirement belongs to the offline client's own contract, not a breaking change to
 * every existing caller of this route today.
 */
router.post('/', async (req, res) => {
  try {
    const {
      facility_id,
      commodity_id,
      quantity,
      dispensed_by,
      dispensed_at,
      notes,
      dsd_site_name,
      sdp_name,
      section,
      location_type,
      batch_number,
      expiry_date,
      client_txn_id
    } = req.body

    // Validate required fields
    if (!facility_id || !commodity_id || quantity === undefined || !dispensed_by) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: facility_id, commodity_id, quantity, dispensed_by',
        code: 'MISSING_FIELDS'
      })
    }

    // Shape-check only when supplied — see the route comment above for why this isn't
    // require()d yet. Validated up front, outside the generic catch below, so a
    // malformed id reads as the same clear 400 every other field violation does here
    // rather than a generic 500.
    let validatedTxnId
    try {
      validatedTxnId = IdempotencyService.validate(client_txn_id)
    } catch (idErr) {
      return sendValidationError(res, idErr.message, 'client_txn_id')
    }

    // Enforce facility scoping (dispense_log write policy)
    if (!(await enforceFacilityWrite(req, res, facility_id, 'dispense_log'))) return
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

    // Quantity must be a whole number >= 0. Zero is allowed on purpose: it records
    // a "nothing consumed today" entry so a facility's daily consumption report
    // still shows a dated record rather than a gap.
    if (!validators.isNonNegativeNumber(quantity)) {
      return sendValidationError(res, 'Quantity must be zero or a positive number', 'quantity')
    }

    // Validate dispensed_at if provided
    if (dispensed_at && !validators.isValidDate(dispensed_at)) {
      return sendValidationError(res, 'dispensed_at must be a valid date', 'dispensed_at')
    }

    const dispense = await LogService.recordDispense({
      facility_id,
      commodity_id,
      quantity: parseInt(quantity),
      dispensed_by,
      dispensed_at,
      notes,
      dsd_site_name,
      sdp_name,
      section,
      location_type,
      batch_number,
      expiry_date,
      client_txn_id: validatedTxnId,
      actor_user_id: req.user?.sub ?? null
    })

    res.status(201).json({
      success: true,
      data: dispense,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    // A 409 is an expected refusal (bin can't cover the draw / expired or short
    // batch), not a server fault — pass it through so the UI shows the real reason
    // instead of a generic error.
    const status = err.status === 409 ? 409 : 500
    if (status === 500) console.error('Error recording dispense:', err)
    res.status(status).json({
      success: false,
      error: err.message,
      code: status === 409 ? 'INSUFFICIENT_STOCK' : 'DISPENSE_ERROR'
    })
  }
})

/**
 * GET /api/dispense - Get dispense history
 * Query params: facility_id (required), dsd_site_name or sdp_name (optional), date (optional, YYYY-MM-DD)
 */
router.get('/', async (req, res) => {
  try {
    const {
      facility_id, facility_ids, dsd_site_name, sdp_name,
      date, from, to, commodity_ids, section, limit = 1000, offset = 0
    } = req.query

    if (date && date.trim() && !validators.isValidISODate(date)) {
      return sendValidationError(res, 'date must be in YYYY-MM-DD format', 'date')
    }
    const commodityIds = commodity_ids ? String(commodity_ids).split(',').map(s => s.trim()).filter(Boolean) : null
    const base = { dsdSiteName: dsd_site_name, sdpName: sdp_name, date, from, to, commodityIds, ...sectionFilter(req), section, limit: parseInt(limit), offset: parseInt(offset) }

    let history
    if (facility_id) {
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      if (!(await enforceFacilityRead(req, res, facility_id, 'dispense_log'))) return
      history = await LogService.getDispenseHistory(facility_id, base)
    } else {
      // Scoped/multi-facility path (reports, admin views). Facility set derived
      // from the token, intersected with the optional facility_ids view-filter.
      const facilityIds = await resolveListFacilityIds(req, 'dispense_log', facility_ids)
      history = await LogService.getDispenseHistory(null, { ...base, facilityIds: facilityIds === null ? undefined : facilityIds })
    }

    res.json({
      success: true,
      data: history,
      count: history.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching dispense history:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

/**
 * GET /api/dispense/summary - consumption aggregated server-side.
 *
 * Returns a few dozen to a few hundred rows instead of every dispense row, so the
 * caller never downloads the log to sum it. Monitoring used to drain dispense_log
 * at 1000 rows a page (~23 SEQUENTIAL requests, ~17 MB, ~25 s in production) purely
 * to compute totals, a per-commodity table, a daily series and a facility
 * breakdown — all of which are sums.
 *
 * `group_by` selects one of an explicit ALLOWLIST of shapes (see
 * DISPENSE_GROUP_BY in logService.js); it is not a generic GROUP BY and arbitrary
 * values are rejected. Default is 'commodity,month', the original AMC shape, so
 * existing dashboard callers are unaffected.
 *
 * Query params: facility_id | facility_ids | state / lga, from, to, commodity_ids,
 * section (all as before), plus group_by, commodity_id / category (drill-in
 * narrowing) and tz (timezone for day buckets; UTC when omitted).
 *
 * Every row carries qty (sum) and txn (count) — txn is what Monitoring's
 * "Consumption records" figure counts.
 */
router.get('/summary', async (req, res) => {
  try {
    const { facility_id, facility_ids, from, to, commodity_ids, section,
            group_by, commodity_id, category, tz } = req.query
    const commodityIds = commodity_ids ? String(commodity_ids).split(',').map(s => s.trim()).filter(Boolean) : null

    // Only the allowlisted groupings are servable. Anything else is a 400 rather
    // than an attempt to build SQL from the query string.
    const groupBy = group_by ? String(group_by) : 'commodity,month'
    if (!DISPENSE_GROUP_BY_KEYS.includes(groupBy)) {
      return sendValidationError(res,
        `Unsupported group_by. Must be one of: ${DISPENSE_GROUP_BY_KEYS.join(' | ')}`, 'group_by')
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
    }
    let rows
    if (facility_id) {
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      if (!(await enforceFacilityRead(req, res, facility_id, 'dispense_log'))) return
      rows = await LogService.getDispenseSummary(facility_id, base)
    } else {
      const facilityIds = await resolveListFacilityIds(req, 'dispense_log', facility_ids)
      rows = await LogService.getDispenseSummary(null, { ...base, facilityIds: facilityIds === null ? undefined : facilityIds })
    }
    res.json({ success: true, data: rows, count: rows.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching dispense summary:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

/**
 * PATCH /api/dispense/:id - Edit a dispense record (metadata only; the client
 * reconciles stock separately). Scoped to the row's facility (own facility or admin).
 */
router.patch('/:id', async (req, res) => {
  try {
    const row = await LogService.getLogRow('dispense', req.params.id)
    if (!row) return res.status(404).json({ success: false, error: 'Dispense record not found', code: 'NOT_FOUND' })
    if (!(await enforceFacilityWrite(req, res, row.facility_id, 'dispense_log'))) return
    if (!(await enforceCommoditySection(req, res, row.commodity_id))) return

    const updated = await LogService.updateLog('dispense', req.params.id, req.body || {})
    res.json({ success: true, data: updated, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error updating dispense record:', err)
    res.status(500).json({ success: false, error: err.message, code: 'UPDATE_ERROR' })
  }
})

export default router
