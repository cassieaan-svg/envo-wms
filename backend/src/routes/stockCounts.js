import express from 'express'
import { validators, sendValidationError } from '../middleware/validation.js'
import { enforceFacilityWrite, enforceFacilityRead, enforceCommoditySection } from '../middleware/scope.js'
import { LogService } from '../services/logService.js'
import { StockService } from '../services/stockService.js'

const router = express.Router()

// Auth + scope applied globally to /api (server.js). A stock count writes stock and
// posts an adjustment, so it takes the same write policy as an adjustment.

/**
 * POST /api/stock-counts - Record a physical stock count and reconcile the bin to it.
 *
 * Body: { facility_id, commodity_id, counted_quantity, counted_by,
 *         location_type (store|dispensary|dsd|sdp, default store),
 *         site_name (required for dsd/sdp), counted_at (optional), notes, section }
 *
 * counted_quantity is WHAT WAS ON THE SHELF — never a delta. The service reads the
 * system figure itself and derives the adjustment from the variance, which is what
 * makes a repeated count idempotent (the retired 'Physical count correction' asked
 * for a delta, and staff entered the count, silently over-deducting).
 */
router.post('/', async (req, res) => {
  try {
    const {
      facility_id, commodity_id, counted_quantity, counted_by,
      location_type = 'store', site_name, counted_at, notes, section
    } = req.body

    if (!facility_id || !commodity_id || counted_quantity === undefined || !counted_by) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: facility_id, commodity_id, counted_quantity, counted_by',
        code: 'MISSING_FIELDS'
      })
    }

    // 0 is a legitimate count ("the shelf is empty") — must not be rejected.
    if (!validators.isNonNegativeNumber(counted_quantity)) {
      return sendValidationError(res, 'counted_quantity must be 0 or more', 'counted_quantity')
    }
    if (!['store', 'dispensary', 'dsd', 'sdp'].includes(location_type)) {
      return sendValidationError(res, "location_type must be 'store', 'dispensary', 'dsd' or 'sdp'", 'location_type')
    }
    if ((location_type === 'dsd' || location_type === 'sdp') && !site_name) {
      return sendValidationError(res, 'site_name is required when counting a DSD/SDP bin', 'site_name')
    }
    if (counted_at && !validators.isValidDate(counted_at)) {
      return sendValidationError(res, 'counted_at must be a valid date', 'counted_at')
    }

    if (!(await enforceFacilityWrite(req, res, facility_id, 'adjustment_log'))) return
    if (!(await enforceCommoditySection(req, res, commodity_id))) return

    if (!(await StockService.facilityExists(facility_id))) {
      return res.status(404).json({ success: false, error: 'Facility not found', code: 'FACILITY_NOT_FOUND' })
    }
    if (!(await StockService.commodityExists(commodity_id))) {
      return res.status(404).json({ success: false, error: 'Commodity not found', code: 'COMMODITY_NOT_FOUND' })
    }

    const count = await LogService.recordStockCount({
      facility_id, commodity_id, location_type, site_name,
      counted_quantity: parseInt(counted_quantity), counted_by, counted_at, notes, section
    })

    res.status(201).json({ success: true, data: count, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error recording stock count:', err)
    res.status(500).json({ success: false, error: err.message, code: 'STOCK_COUNT_ERROR' })
  }
})

/**
 * GET /api/stock-counts?facility_id=&commodity_id=&limit= - Count history.
 * Shows counted vs system vs variance, which is the audit trail the retired
 * adjustment-only flow could never provide.
 */
router.get('/', async (req, res) => {
  try {
    const { facility_id, commodity_id, limit = 100 } = req.query
    if (!facility_id) return sendValidationError(res, 'facility_id is required', 'facility_id')
    if (!(await enforceFacilityRead(req, res, facility_id))) return

    const rows = await LogService.getStockCountHistory(facility_id, {
      commodityId: commodity_id || null,
      limit: Math.min(parseInt(limit) || 100, 500)
    })
    res.json({ success: true, data: rows, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching stock counts:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

export default router
