import { sbAdmin } from '../supabase.js'

export class ReportService {
  /**
   * Get daily activity report
   */
  static async getDailyReport(facilityId, date, options = {}) {
    const { category = 'all' } = options

    if (!date) {
      throw new Error('date is required in YYYY-MM-DD format')
    }

    const startOfDay = `${date}T00:00:00`
    const endOfDay = `${date}T23:59:59`

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
        const { data: intake, error: intakeError } = await sbAdmin
          .from('intake_log')
          .select('*,commodities(id,name,category,unit)')
          .eq('facility_id', facilityId)
          .gte('received_at', startOfDay)
          .lte('received_at', endOfDay)
          .order('received_at')

        if (intakeError) throw intakeError
        report.intake = intake || []
        report.summary.total_intake = report.intake.reduce((sum, item) => sum + item.quantity, 0)
      }

      // Get dispense data
      if (category === 'all' || category === 'dispense') {
        const { data: dispense, error: dispenseError } = await sbAdmin
          .from('dispense_log')
          .select('*,commodities(id,name,category,unit)')
          .eq('facility_id', facilityId)
          .gte('dispensed_at', startOfDay)
          .lte('dispensed_at', endOfDay)
          .order('dispensed_at')

        if (dispenseError) throw dispenseError
        report.dispense = dispense || []
        report.summary.total_dispense = report.dispense.reduce((sum, item) => sum + item.quantity, 0)
      }

      // Get adjustment data
      if (category === 'all' || category === 'adjustment') {
        const { data: adjustments, error: adjError } = await sbAdmin
          .from('stock_adjustment_log')
          .select('*,commodities(id,name,category,unit)')
          .eq('facility_id', facilityId)
          .gte('adjusted_at', startOfDay)
          .lte('adjusted_at', endOfDay)
          .order('adjusted_at')

        if (adjError) throw adjError
        report.adjustments = adjustments || []
        report.summary.total_adjustments = report.adjustments.length
      }

      // Get transfer data
      if (category === 'all' || category === 'transfer') {
        const { data: transfers, error: transferError } = await sbAdmin
          .from('stock_transfer_log')
          .select('*,commodities(id,name,category,unit)')
          .or(`sending_facility_id.eq.${facilityId},receiving_facility_id.eq.${facilityId}`)
          .gte('initiated_at', startOfDay)
          .lte('initiated_at', endOfDay)
          .order('initiated_at')

        if (transferError) throw transferError
        report.transfers = transfers || []
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
    const { category = 'all' } = options

    if (!fromDate || !toDate) {
      throw new Error('fromDate and toDate are required in YYYY-MM-DD format')
    }

    try {
      const startDate = `${fromDate}T00:00:00`
      const endDate = `${toDate}T23:59:59`

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
        const { data, error } = await sbAdmin
          .from('intake_log')
          .select('*,commodities(id,name,category,unit)')
          .eq('facility_id', facilityId)
          .gte('received_at', startDate)
          .lte('received_at', endDate)

        if (error) throw error
        allIntake = data || []
        report.summary.total_intake = allIntake.reduce((sum, item) => sum + item.quantity, 0)
      }

      if (category === 'all' || category === 'dispense') {
        const { data, error } = await sbAdmin
          .from('dispense_log')
          .select('*,commodities(id,name,category,unit)')
          .eq('facility_id', facilityId)
          .gte('dispensed_at', startDate)
          .lte('dispensed_at', endDate)

        if (error) throw error
        allDispense = data || []
        report.summary.total_dispense = allDispense.reduce((sum, item) => sum + item.quantity, 0)
      }

      if (category === 'all' || category === 'adjustment') {
        const { data, error } = await sbAdmin
          .from('stock_adjustment_log')
          .select('*,commodities(id,name,category,unit)')
          .eq('facility_id', facilityId)
          .gte('adjusted_at', startDate)
          .lte('adjusted_at', endDate)

        if (error) throw error
        allAdjustments = data || []
        report.summary.total_adjustments = allAdjustments.length
      }

      if (category === 'all' || category === 'transfer') {
        const { data, error } = await sbAdmin
          .from('stock_transfer_log')
          .select('*,commodities(id,name,category,unit)')
          .or(`sending_facility_id.eq.${facilityId},receiving_facility_id.eq.${facilityId}`)
          .gte('initiated_at', startDate)
          .lte('initiated_at', endDate)

        if (error) throw error
        allTransfers = data || []
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
    const { category = 'all' } = options

    if (!month || !month.match(/^\d{4}-\d{2}$/)) {
      throw new Error('month is required in YYYY-MM format')
    }

    try {
      const [year, monthNum] = month.split('-')
      const startDate = `${year}-${monthNum}-01T00:00:00`
      // Get last day of month
      const lastDay = new Date(parseInt(year), parseInt(monthNum), 0).getDate()
      const endDate = `${year}-${monthNum}-${lastDay}T23:59:59`

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
        const { data, error } = await sbAdmin
          .from('intake_log')
          .select('*,commodities(id,name,category,unit)')
          .eq('facility_id', facilityId)
          .gte('received_at', startDate)
          .lte('received_at', endDate)

        if (error) throw error
        allIntake = data || []
        report.summary.total_intake = allIntake.reduce((sum, item) => sum + item.quantity, 0)
      }

      if (category === 'all' || category === 'dispense') {
        const { data, error } = await sbAdmin
          .from('dispense_log')
          .select('*,commodities(id,name,category,unit)')
          .eq('facility_id', facilityId)
          .gte('dispensed_at', startDate)
          .lte('dispensed_at', endDate)

        if (error) throw error
        allDispense = data || []
        report.summary.total_dispense = allDispense.reduce((sum, item) => sum + item.quantity, 0)
      }

      if (category === 'all' || category === 'adjustment') {
        const { data, error } = await sbAdmin
          .from('stock_adjustment_log')
          .select('*,commodities(id,name,category,unit)')
          .eq('facility_id', facilityId)
          .gte('adjusted_at', startDate)
          .lte('adjusted_at', endDate)

        if (error) throw error
        allAdjustments = data || []
        report.summary.total_adjustments = allAdjustments.length
      }

      if (category === 'all' || category === 'transfer') {
        const { data, error } = await sbAdmin
          .from('stock_transfer_log')
          .select('*,commodities(id,name,category,unit)')
          .or(`sending_facility_id.eq.${facilityId},receiving_facility_id.eq.${facilityId}`)
          .gte('initiated_at', startDate)
          .lte('initiated_at', endDate)

        if (error) throw error
        allTransfers = data || []
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
  static async getStockBalance(facilityId, asOfDate = null) {
    try {
      let query = sbAdmin
        .from('stock')
        .select('*,commodities(id,name,category,unit),facilities(id,name)')
        .eq('facility_id', facilityId)

      const { data, error } = await query

      if (error) throw error

      // Calculate balance accounting for all transactions up to asOfDate if provided
      const balance = {}
      data?.forEach(stock => {
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
  static async exportCSV(facilityId, fromDate, toDate, category = 'all') {
    try {
      const startDate = `${fromDate}T00:00:00`
      const endDate = `${toDate}T23:59:59`

      let csvData = 'Date,Type,Commodity,Quantity,Reference,Notes\n'

      if (category === 'all' || category === 'intake') {
        const { data } = await sbAdmin
          .from('intake_log')
          .select('*,commodities(id,name)')
          .eq('facility_id', facilityId)
          .gte('received_at', startDate)
          .lte('received_at', endDate)
          .order('received_at')

        data?.forEach(item => {
          csvData += `${item.received_at?.split('T')[0]},INTAKE,"${item.commodities?.name}",${item.quantity},"${item.delivery_note_ref || ''}","${item.notes || ''}"\n`
        })
      }

      if (category === 'all' || category === 'dispense') {
        const { data } = await sbAdmin
          .from('dispense_log')
          .select('*,commodities(id,name)')
          .eq('facility_id', facilityId)
          .gte('dispensed_at', startDate)
          .lte('dispensed_at', endDate)
          .order('dispensed_at')

        data?.forEach(item => {
          csvData += `${item.dispensed_at?.split('T')[0]},DISPENSE,"${item.commodities?.name}",${item.quantity},"${item.dispensed_by || ''}","${item.notes || ''}"\n`
        })
      }

      if (category === 'all' || category === 'adjustment') {
        const { data } = await sbAdmin
          .from('stock_adjustment_log')
          .select('*,commodities(id,name)')
          .eq('facility_id', facilityId)
          .gte('adjusted_at', startDate)
          .lte('adjusted_at', endDate)
          .order('adjusted_at')

        data?.forEach(item => {
          csvData += `${item.adjusted_at?.split('T')[0]},${item.adjustment_type},"${item.commodities?.name}",${item.quantity},"${item.reason}","${item.notes || ''}"\n`
        })
      }

      return csvData
    } catch (err) {
      console.error('Error exporting CSV:', err)
      throw err
    }
  }
}
