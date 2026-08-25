import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { resolveListFacilityIds, enforceFacilityRead, sectionFilter } from '../middleware/scope.js'
import { LogService } from '../services/logService.js'

const router = express.Router()

// The four logs this feed merges. Also the allowlist for `types` — anything else
// is a client error rather than a silently empty result.
const TYPES = ['dispense', 'intake', 'adjustment', 'transfer']

/**
 * GET /api/activity - one time-ordered feed across dispense, intake, adjustment
 * and transfer, paged.
 *
 * Replaces "fetch each log, merge in the browser, cut to N", which could not be
 * paged correctly: page 2 of a merged stream is not page 2 of any single log, so
 * a Next button over the client-side merge returns pages with records missing
 * from the middle. Merging in SQL makes the ordering total, so limit/offset are
 * exact and the caller fetches only what it shows — a monthly report was draining
 * ~23,000 rows over ~24 sequential requests to fill one screen.
 *
 * Query: from / to (ISO), facility_id | facility_ids | state / lga, commodity_ids,
 * section, types (CSV of the four), limit, offset.
 * Returns { data, total, limit, offset } — `total` is the count across the whole
 * feed, so the caller can render "page 2 of 24" without a second request.
 */
router.get('/', async (req, res) => {
  try {
    const { facility_id, facility_ids, from, to, commodity_ids, section, types,
            category, external_only, limit = 50, offset = 0 } = req.query

    const typeList = types
      ? String(types).split(',').map(s => s.trim()).filter(Boolean)
      : null
    if (typeList && typeList.some(t => !TYPES.includes(t))) {
      return sendValidationError(res, `types must be a comma-separated subset of: ${TYPES.join(', ')}`, 'types')
    }

    // Capped so a caller cannot ask for the whole feed in one request and undo the
    // point of the endpoint. The CSV export pages through instead.
    const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 500)
    const off = Math.max(parseInt(offset) || 0, 0)

    const base = {
      from, to,
      commodityIds: commodity_ids ? String(commodity_ids).split(',').map(s => s.trim()).filter(Boolean) : null,
      ...sectionFilter(req),
      section,
      types: typeList,
      category: category || null,
      externalOnly: external_only === '1' || external_only === 'true',
      limit: lim, offset: off,
    }

    let result
    if (facility_id) {
      if (!validators.isUUID(facility_id)) return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
      // dispense_log stands in for all four: they share one set of read tiers.
      if (!(await enforceFacilityRead(req, res, facility_id, 'dispense_log'))) return
      result = await LogService.getActivityFeed({ ...base, facilityId: facility_id })
    } else {
      const facilityIds = await resolveListFacilityIds(req, 'dispense_log', facility_ids)
      result = await LogService.getActivityFeed({
        ...base, facilityIds: facilityIds === null ? undefined : facilityIds,
      })
    }

    res.json({
      success: true,
      data: result.rows,
      total: result.total,
      count: result.rows.length,
      limit: lim,
      offset: off,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    console.error('Error fetching activity feed:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

export default router
