import express from 'express'
import { validateQuery, validators, sendValidationError } from '../middleware/validation.js'
import { enforceFacilityRead } from '../middleware/scope.js'
import { ReportService } from '../services/reportService.js'
import { StockService } from '../services/stockService.js'

const router = express.Router()

// Auth + scope applied globally to /api (server.js). Reports aggregate the
// per-facility log/stock tables, so each report is gated by facility read access
// (own facility, or a read-admin narrowed to their state/lga) using the log read
// policy as the representative rule.

/**
 * GET /api/reports/daily - Get daily activity report
 * Query params: facility_id (required), date (required, YYYY-MM-DD), category (optional)
 */
router.get('/daily', validateQuery(['facility_id', 'date']), async (req, res) => {
  try {
    const { facility_id, date, category = 'all' } = req.query

    // Validate facility_id is UUID
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    // Validate date format
    if (!validators.isValidISODate(date)) {
      return sendValidationError(res, 'date must be in YYYY-MM-DD format', 'date')
    }

    // Enforce facility scoping
    if (!(await enforceFacilityRead(req, res, facility_id, 'dispense_log'))) return

    // Validate category
    const validCategories = ['all', 'intake', 'dispense', 'adjustment', 'transfer']
    if (!validCategories.includes(category)) {
      return sendValidationError(
        res,
        'category must be one of: all, intake, dispense, adjustment, transfer',
        'category'
      )
    }

    // Verify facility exists
    const facilityExists = await StockService.facilityExists(facility_id)
    if (!facilityExists) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
        code: 'FACILITY_NOT_FOUND'
      })
    }

    const report = await ReportService.getDailyReport(facility_id, date, { category })

    res.json({
      success: true,
      data: report,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error generating daily report:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'REPORT_ERROR'
    })
  }
})

/**
 * GET /api/reports/weekly - Get weekly activity report (aggregated)
 * Query params: facility_id (required), from (required, YYYY-MM-DD), to (required, YYYY-MM-DD), category (optional)
 */
router.get('/weekly', validateQuery(['facility_id', 'from', 'to']), async (req, res) => {
  try {
    const { facility_id, from, to, category = 'all' } = req.query

    // Validate facility_id is UUID
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    // Enforce facility scoping
    if (!(await enforceFacilityRead(req, res, facility_id, 'dispense_log'))) return

    // Validate from date
    if (!validators.isValidISODate(from)) {
      return sendValidationError(res, 'from must be in YYYY-MM-DD format', 'from')
    }

    // Validate to date
    if (!validators.isValidISODate(to)) {
      return sendValidationError(res, 'to must be in YYYY-MM-DD format', 'to')
    }

    // Validate from <= to
    if (from > to) {
      return res.status(400).json({
        success: false,
        error: 'from date must be before or equal to to date',
        code: 'INVALID_DATE_RANGE'
      })
    }

    // Validate category
    const validCategories = ['all', 'intake', 'dispense', 'adjustment', 'transfer']
    if (!validCategories.includes(category)) {
      return sendValidationError(
        res,
        'category must be one of: all, intake, dispense, adjustment, transfer',
        'category'
      )
    }

    // Verify facility exists
    const facilityExists = await StockService.facilityExists(facility_id)
    if (!facilityExists) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
        code: 'FACILITY_NOT_FOUND'
      })
    }

    const report = await ReportService.getWeeklyReport(facility_id, from, to, { category })

    res.json({
      success: true,
      data: report,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error generating weekly report:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'REPORT_ERROR'
    })
  }
})

/**
 * GET /api/reports/monthly - Get monthly activity report (aggregated)
 * Query params: facility_id (required), month (required, YYYY-MM), category (optional)
 */
router.get('/monthly', validateQuery(['facility_id', 'month']), async (req, res) => {
  try {
    const { facility_id, month, category = 'all' } = req.query

    // Validate facility_id is UUID
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    // Validate month format (YYYY-MM)
    if (!month.match(/^\d{4}-\d{2}$/)) {
      return sendValidationError(res, 'month must be in YYYY-MM format', 'month')
    }

    // Enforce facility scoping
    if (!(await enforceFacilityRead(req, res, facility_id, 'dispense_log'))) return

    // Validate category
    const validCategories = ['all', 'intake', 'dispense', 'adjustment', 'transfer']
    if (!validCategories.includes(category)) {
      return sendValidationError(
        res,
        'category must be one of: all, intake, dispense, adjustment, transfer',
        'category'
      )
    }

    // Verify facility exists
    const facilityExists = await StockService.facilityExists(facility_id)
    if (!facilityExists) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
        code: 'FACILITY_NOT_FOUND'
      })
    }

    const report = await ReportService.getMonthlyReport(facility_id, month, { category })

    res.json({
      success: true,
      data: report,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error generating monthly report:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'REPORT_ERROR'
    })
  }
})

/**
 * GET /api/reports/stock-balance - Get current stock balance
 * Query params: facility_id (required), as_of_date (optional, YYYY-MM-DD)
 */
router.get('/stock-balance', validateQuery(['facility_id']), async (req, res) => {
  try {
    const { facility_id, as_of_date } = req.query

    // Validate facility_id is UUID
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    // Validate as_of_date if provided
    if (as_of_date && !validators.isValidISODate(as_of_date)) {
      return sendValidationError(res, 'as_of_date must be in YYYY-MM-DD format', 'as_of_date')
    }

    // Enforce facility scoping
    if (!(await enforceFacilityRead(req, res, facility_id, 'dispense_log'))) return

    // Verify facility exists
    const facilityExists = await StockService.facilityExists(facility_id)
    if (!facilityExists) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
        code: 'FACILITY_NOT_FOUND'
      })
    }

    const balance = await ReportService.getStockBalance(facility_id, as_of_date)

    res.json({
      success: true,
      data: balance,
      count: balance.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching stock balance:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'REPORT_ERROR'
    })
  }
})

/**
 * GET /api/reports/export - Export report data as CSV
 * Query params: facility_id (required), from (required, YYYY-MM-DD), to (required, YYYY-MM-DD), category (optional), format (optional, csv/json)
 */
router.get('/export', validateQuery(['facility_id', 'from', 'to']), async (req, res) => {
  try {
    const { facility_id, from, to, category = 'all', format = 'csv' } = req.query

    // Validate facility_id is UUID
    if (!validators.isUUID(facility_id)) {
      return sendValidationError(res, 'Invalid facility_id format', 'facility_id')
    }

    // Enforce facility scoping
    if (!(await enforceFacilityRead(req, res, facility_id, 'dispense_log'))) return

    // Validate from date
    if (!validators.isValidISODate(from)) {
      return sendValidationError(res, 'from must be in YYYY-MM-DD format', 'from')
    }

    // Validate to date
    if (!validators.isValidISODate(to)) {
      return sendValidationError(res, 'to must be in YYYY-MM-DD format', 'to')
    }

    // Validate from <= to
    if (from > to) {
      return res.status(400).json({
        success: false,
        error: 'from date must be before or equal to to date',
        code: 'INVALID_DATE_RANGE'
      })
    }

    // Validate category
    const validCategories = ['all', 'intake', 'dispense', 'adjustment', 'transfer']
    if (!validCategories.includes(category)) {
      return sendValidationError(
        res,
        'category must be one of: all, intake, dispense, adjustment, transfer',
        'category'
      )
    }

    // Validate format
    if (!['csv', 'json'].includes(format)) {
      return sendValidationError(res, 'format must be csv or json', 'format')
    }

    // Verify facility exists
    const facilityExists = await StockService.facilityExists(facility_id)
    if (!facilityExists) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
        code: 'FACILITY_NOT_FOUND'
      })
    }

    if (format === 'csv') {
      const csvData = await ReportService.exportCSV(facility_id, from, to, category)
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', `attachment; filename="report_${from}_to_${to}.csv"`)
      res.send(csvData)
    } else {
      // JSON format - get weekly report as structured data
      const report = await ReportService.getWeeklyReport(facility_id, from, to, { category })
      res.json({
        success: true,
        data: report,
        timestamp: new Date().toISOString()
      })
    }
  } catch (err) {
    console.error('Error exporting report:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'EXPORT_ERROR'
    })
  }
})

export default router
