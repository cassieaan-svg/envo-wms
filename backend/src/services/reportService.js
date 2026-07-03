import { query } from '../db.js'

// Nested commodity object matching the frontend's `commodities(id,name,category,unit)`
// embedded select, rebuilt with json_build_object (PostgREST replacement).
const COMM4_OBJ = `
  json_build_object('id', c.id, 'name', c.name, 'category', c.category, 'unit', c.unit) as commodities`

// Lighter commodity object for the CSV export (only id + name are used).
const COMM2_OBJ = `
  json_build_object('id', c.id, 'name', c.name) as commodities`

// Inclusive timestamp bounds for a YYYY-MM-DD date (mirrors the old gte/lte).
function dayBounds(date) {
  return [`${date}T00:00:00`, `${date}T23:59:59`]
}

// YYYY-MM-DD portion of a timestamp. Supabase returned ISO strings; node-pg
// returns Date objects for timestamptz columns, so handle both.
function dateOnly(v) {
  if (!v) return ''
  if (v instanceof Date) return v.toISOString().split('T')[0]
  return String(v).split('T')[0]
}

export class ReportService {
  /**
   * Get daily activity report
   */
  static async getDailyReport(facilityId, date, options = {}) {
    const { category = 'all', categories = null } = options

    if (!date) {
      throw new Error('date is required in YYYY-MM-DD format')
    }

    const [startOfDay, endOfDay] = dayBounds(date)
    // Section enforcement: optional 4th param filtering by commodity category.
    const catCond = Array.isArray(categories) && categories.length ? ' and c.category = any($4)' : ''
    const catP = Array.isArray(categories) && categories.length ? [categories] : []

    try {
      const report = {
        date,
        facility_id: facilityId,
        category,
        summary: {
          total_intake: 0,
          total_dispense: 0,
          total_adjustments: 0,
          total_transfers: 0
        },
        intake: [],
        dispense: [],
        adjustments: [],
        transfers: []
      }

      // Get intake data
      if (category === 'all' || category === 'intake') {
        const { rows } = await query(
          `select l.*, ${COMM4_OBJ}
           from intake_log l
           left join commodities c on c.id = l.commodity_id
           where l.facility_id = $1 and l.received_at >= $2 and l.received_at <= $3${catCond}
           order by l.received_at`,
          [facilityId, startOfDay, endOfDay, ...catP]
        )
        report.intake = rows
        report.summary.total_intake = report.intake.reduce((sum, item) => sum + item.quantity, 0)
      }

      // Get dispense data
      if (category === 'all' || category === 'dispense') {
        const { rows } = await query(
          `select l.*, ${COMM4_OBJ}
           from dispense_log l
           left join commodities c on c.id = l.commodity_id
           where l.facility_id = $1 and l.dispensed_at >= $2 and l.dispensed_at <= $3${catCond}
           order by l.dispensed_at`,
          [facilityId, startOfDay, endOfDay, ...catP]
        )
        report.dispense = rows
        report.summary.total_dispense = report.dispense.reduce((sum, item) => sum + item.quantity, 0)
      }

      // Get adjustment data
      if (category === 'all' || category === 'adjustment') {
        const { rows } = await query(
          `select l.*, ${COMM4_OBJ}
           from stock_adjustment_log l
           left join commodities c on c.id = l.commodity_id
           where l.facility_id = $1 and l.adjusted_at >= $2 and l.adjusted_at <= $3${catCond}
           order by l.adjusted_at`,
          [facilityId, startOfDay, endOfDay, ...catP]
        )
        report.adjustments = rows
        report.summary.total_adjustments = report.adjustments.length
      }

      // Get transfer data
      if (category === 'all' || category === 'transfer') {
        const { rows } = await query(
          `select l.*, ${COMM4_OBJ}
           from stock_transfer_log l
           left join commodities c on c.id = l.commodity_id
           where (l.sending_facility_id = $1 or l.receiving_facility_id = $1)
             and l.initiated_at >= $2 and l.initiated_at <= $3${catCond}
           order by l.initiated_at`,
          [facilityId, startOfDay, endOfDay, ...catP]
        )
        report.transfers = rows
        report.summary.total_transfers = report.transfers.length
      }

      return report
    } catch (err) {
      console.error('Error generating daily report:', err)
      throw err
    }
  }

  /**
   * Get weekly activity report (aggregated)
   */
  static async getWeeklyReport(facilityId, fromDate, toDate, options = {}) {
    const { category = 'all', categories = null } = options

    if (!fromDate || !toDate) {
      throw new Error('fromDate and toDate are required in YYYY-MM-DD format')
    }

    try {
      const startDate = `${fromDate}T00:00:00`
      const endDate = `${toDate}T23:59:59`
      const catCond = Array.isArray(categories) && categories.length ? ' and c.category = any($4)' : ''
      const catP = Array.isArray(categories) && categories.length ? [categories] : []

      const report = {
        from_date: fromDate,
        to_date: toDate,
        facility_id: facilityId,
        category,
        summary: {
          total_intake: 0,
          total_dispense: 0,
          total_adjustments: 0,
          total_transfers: 0,
          commodities_count: 0
        },
        daily_breakdown: {},
        commodities: {}
      }

      // Get all data for the period
      let allIntake = [],
        allDispense = [],
        allAdjustments = [],
        allTransfers = []

      if (category === 'all' || category === 'intake') {
        const { rows } = await query(
          `select l.*, ${COMM4_OBJ}
           from intake_log l
           left join commodities c on c.id = l.commodity_id
           where l.facility_id = $1 and l.received_at >= $2 and l.received_at <= $3${catCond}`,
          [facilityId, startDate, endDate, ...catP]
        )
        allIntake = rows
        report.summary.total_intake = allIntake.reduce((sum, item) => sum + item.quantity, 0)
      }

      if (category === 'all' || category === 'dispense') {
        const { rows } = await query(
          `select l.*, ${COMM4_OBJ}
           from dispense_log l
           left join commodities c on c.id = l.commodity_id
           where l.facility_id = $1 and l.dispensed_at >= $2 and l.dispensed_at <= $3${catCond}`,
          [facilityId, startDate, endDate, ...catP]
        )
        allDispense = rows
        report.summary.total_dispense = allDispense.reduce((sum, item) => sum + item.quantity, 0)
      }

      if (category === 'all' || category === 'adjustment') {
        const { rows } = await query(
          `select l.*, ${COMM4_OBJ}
           from stock_adjustment_log l
           left join commodities c on c.id = l.commodity_id
           where l.facility_id = $1 and l.adjusted_at >= $2 and l.adjusted_at <= $3${catCond}`,
          [facilityId, startDate, endDate, ...catP]
        )
        allAdjustments = rows
        report.summary.total_adjustments = allAdjustments.length
      }

      if (category === 'all' || category === 'transfer') {
        const { rows } = await query(
          `select l.*, ${COMM4_OBJ}
           from stock_transfer_log l
           left join commodities c on c.id = l.commodity_id
           where (l.sending_facility_id = $1 or l.receiving_facility_id = $1)
             and l.initiated_at >= $2 and l.initiated_at <= $3${catCond}`,
          [facilityId, startDate, endDate, ...catP]
        )
        allTransfers = rows
        report.summary.total_transfers = allTransfers.length
      }

      // Aggregate by commodity
      const commodityMap = {}
      ;[...allIntake, ...allDispense, ...allAdjustments].forEach(item => {
        if (!commodityMap[item.commodity_id]) {
          commodityMap[item.commodity_id] = {
            id: item.commodity_id,
            name: item.commodities?.name || 'Unknown',
            unit: item.commodities?.unit || '',
            intake: 0,
            dispense: 0,
            adjustments: 0
          }
        }
        if (item.received_at) commodityMap[item.commodity_id].intake += item.quantity || 0
        if (item.dispensed_at) commodityMap[item.commodity_id].dispense += item.quantity || 0
      })

      report.commodities = Object.values(commodityMap)
      report.summary.commodities_count = report.commodities.length

      return report
    } catch (err) {
      console.error('Error generating weekly report:', err)
      throw err
    }
  }

  /**
   * Get monthly activity report (aggregated)
   */
  static async getMonthlyReport(facilityId, month, options = {}) {
    const { category = 'all', categories = null } = options

    if (!month || !month.match(/^\d{4}-\d{2}$/)) {
      throw new Error('month is required in YYYY-MM format')
    }

    try {
      const [year, monthNum] = month.split('-')
      const startDate = `${year}-${monthNum}-01T00:00:00`
      // Get last day of month
      const lastDay = new Date(parseInt(year), parseInt(monthNum), 0).getDate()
      const endDate = `${year}-${monthNum}-${lastDay}T23:59:59`
      const catCond = Array.isArray(categories) && categories.length ? ' and c.category = any($4)' : ''
      const catP = Array.isArray(categories) && categories.length ? [categories] : []

      const report = {
        month,
        facility_id: facilityId,
        category,
        summary: {
          total_intake: 0,
          total_dispense: 0,
          total_adjustments: 0,
          total_transfers: 0,
          commodities_count: 0
        },
        commodities: {}
      }

      // Get all data for the month
      let allIntake = [],
        allDispense = [],
        allAdjustments = [],
        allTransfers = []

      if (category === 'all' || category === 'intake') {
        const { rows } = await query(
          `select l.*, ${COMM4_OBJ}
           from intake_log l
           left join commodities c on c.id = l.commodity_id
           where l.facility_id = $1 and l.received_at >= $2 and l.received_at <= $3${catCond}`,
          [facilityId, startDate, endDate, ...catP]
        )
        allIntake = rows
        report.summary.total_intake = allIntake.reduce((sum, item) => sum + item.quantity, 0)
      }

      if (category === 'all' || category === 'dispense') {
        const { rows } = await query(
          `select l.*, ${COMM4_OBJ}
           from dispense_log l
           left join commodities c on c.id = l.commodity_id
           where l.facility_id = $1 and l.dispensed_at >= $2 and l.dispensed_at <= $3${catCond}`,
          [facilityId, startDate, endDate, ...catP]
        )
        allDispense = rows
        report.summary.total_dispense = allDispense.reduce((sum, item) => sum + item.quantity, 0)
      }

      if (category === 'all' || category === 'adjustment') {
        const { rows } = await query(
          `select l.*, ${COMM4_OBJ}
           from stock_adjustment_log l
           left join commodities c on c.id = l.commodity_id
           where l.facility_id = $1 and l.adjusted_at >= $2 and l.adjusted_at <= $3${catCond}`,
          [facilityId, startDate, endDate, ...catP]
        )
        allAdjustments = rows
        report.summary.total_adjustments = allAdjustments.length
      }

      if (category === 'all' || category === 'transfer') {
        const { rows } = await query(
          `select l.*, ${COMM4_OBJ}
           from stock_transfer_log l
           left join commodities c on c.id = l.commodity_id
           where (l.sending_facility_id = $1 or l.receiving_facility_id = $1)
             and l.initiated_at >= $2 and l.initiated_at <= $3${catCond}`,
          [facilityId, startDate, endDate, ...catP]
        )
        allTransfers = rows
        report.summary.total_transfers = allTransfers.length
      }

      // Aggregate by commodity
      const commodityMap = {}
      ;[...allIntake, ...allDispense, ...allAdjustments].forEach(item => {
        if (!commodityMap[item.commodity_id]) {
          commodityMap[item.commodity_id] = {
            id: item.commodity_id,
            name: item.commodities?.name || 'Unknown',
            unit: item.commodities?.unit || '',
            intake: 0,
            dispense: 0,
            adjustments: 0
          }
        }
        if (item.received_at) commodityMap[item.commodity_id].intake += item.quantity || 0
        if (item.dispensed_at) commodityMap[item.commodity_id].dispense += item.quantity || 0
      })

      report.commodities = Object.values(commodityMap)
      report.summary.commodities_count = report.commodities.length

      return report
    } catch (err) {
      console.error('Error generating monthly report:', err)
      throw err
    }
  }

  /**
   * Get stock balance (for reports)
   */
  static async getStockBalance(facilityId, asOfDate = null, options = {}) {
    const { categories = null } = options
    try {
      const catCond = Array.isArray(categories) && categories.length ? ' and c.category = any($2)' : ''
      const catP = Array.isArray(categories) && categories.length ? [categories] : []
      const { rows } = await query(
        `select s.*,
                json_build_object('id', c.id, 'name', c.name, 'category', c.category, 'unit', c.unit) as commodities,
                json_build_object('id', f.id, 'name', f.name) as facilities
         from stock s
         left join commodities c on c.id = s.commodity_id
         left join facilities f on f.id = s.facility_id
         where s.facility_id = $1${catCond}`,
        [facilityId, ...catP]
      )

      // Calculate balance accounting for all transactions up to asOfDate if provided
      const balance = {}
      rows.forEach(stock => {
        balance[stock.commodity_id] = {
          id: stock.id,
          commodity_id: stock.commodity_id,
          commodity_name: stock.commodities?.name || 'Unknown',
          unit: stock.commodities?.unit || '',
          quantity: stock.quantity,
          location_type: stock.location_type
        }
      })

      return Object.values(balance)
    } catch (err) {
      console.error('Error getting stock balance:', err)
      throw err
    }
  }

  /**
   * Export data as CSV format
   */
  static async exportCSV(facilityId, fromDate, toDate, category = 'all', options = {}) {
    const { categories = null } = options
    try {
      const startDate = `${fromDate}T00:00:00`
      const endDate = `${toDate}T23:59:59`
      const catCond = Array.isArray(categories) && categories.length ? ' and c.category = any($4)' : ''
      const catP = Array.isArray(categories) && categories.length ? [categories] : []

      let csvData = 'Date,Type,Commodity,Quantity,Reference,Notes\n'

      if (category === 'all' || category === 'intake') {
        const { rows } = await query(
          `select l.*, ${COMM2_OBJ}
           from intake_log l
           left join commodities c on c.id = l.commodity_id
           where l.facility_id = $1 and l.received_at >= $2 and l.received_at <= $3${catCond}
           order by l.received_at`,
          [facilityId, startDate, endDate, ...catP]
        )
        rows.forEach(item => {
          csvData += `${dateOnly(item.received_at)},INTAKE,"${item.commodities?.name}",${item.quantity},"${item.delivery_note_ref || ''}","${item.notes || ''}"\n`
        })
      }

      if (category === 'all' || category === 'dispense') {
        const { rows } = await query(
          `select l.*, ${COMM2_OBJ}
           from dispense_log l
           left join commodities c on c.id = l.commodity_id
           where l.facility_id = $1 and l.dispensed_at >= $2 and l.dispensed_at <= $3${catCond}
           order by l.dispensed_at`,
          [facilityId, startDate, endDate, ...catP]
        )
        rows.forEach(item => {
          csvData += `${dateOnly(item.dispensed_at)},DISPENSE,"${item.commodities?.name}",${item.quantity},"${item.dispensed_by || ''}","${item.notes || ''}"\n`
        })
      }

      if (category === 'all' || category === 'adjustment') {
        const { rows } = await query(
          `select l.*, ${COMM2_OBJ}
           from stock_adjustment_log l
           left join commodities c on c.id = l.commodity_id
           where l.facility_id = $1 and l.adjusted_at >= $2 and l.adjusted_at <= $3${catCond}
           order by l.adjusted_at`,
          [facilityId, startDate, endDate, ...catP]
        )
        rows.forEach(item => {
          csvData += `${dateOnly(item.adjusted_at)},${item.adjustment_type},"${item.commodities?.name}",${item.quantity},"${item.reason}","${item.notes || ''}"\n`
        })
      }

      return csvData
    } catch (err) {
      console.error('Error exporting CSV:', err)
      throw err
    }
  }
}
