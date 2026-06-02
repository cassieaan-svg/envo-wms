import { sbAdmin } from '../supabase.js'
import { StockService } from './stockService.js'

export class LogService {
  /**
   * Record dispense operation
   * Updates DSD/SDP stock and general stock
   */
  static async recordDispense(dispenseData) {
    const {
      facility_id,
      commodity_id,
      quantity,
      dispensed_by,
      dispensed_at,
      notes,
      dsd_site_name,
      sdp_name,
      section
    } = dispenseData

    if (!facility_id || !commodity_id || !quantity || !dispensed_by) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, dispensed_by')
    }

    try {
      // Record in dispense_log
      const { data: dispenseLog, error: logError } = await sbAdmin
        .from('dispense_log')
        .insert({
          facility_id,
          commodity_id,
          quantity: parseInt(quantity),
          dispensed_by,
          dispensed_at: dispensed_at || new Date().toISOString(),
          notes: notes || '',
          dsd_site_name: dsd_site_name || null,
          sdp_name: sdp_name || null,
          section
        })
        .select()

      if (logError) throw logError

      // Update stock quantity
      if (dsd_site_name) {
        // Update DSD stock
        const dsdStock = await StockService.getDsdStockByFacilitySiteCommodity(
          facility_id,
          dsd_site_name,
          commodity_id
        )

        if (dsdStock) {
          await sbAdmin
            .from('dsd_stock')
            .update({
              quantity: Math.max(0, dsdStock.quantity - parseInt(quantity)),
              updated_at: new Date().toISOString()
            })
            .eq('id', dsdStock.id)
        }
      } else if (sdp_name) {
        // Update SDP stock
        const sdpStock = await StockService.getSdpStockByFacilitySiteCommodity(
          facility_id,
          sdp_name,
          commodity_id
        )

        if (sdpStock) {
          await sbAdmin
            .from('sdp_stock')
            .update({
              quantity: Math.max(0, sdpStock.quantity - parseInt(quantity)),
              updated_at: new Date().toISOString()
            })
            .eq('id', sdpStock.id)
        }
      } else {
        // Update general facility stock
        const stock = await StockService.getStockByFacilityAndCommodity(
          facility_id,
          commodity_id,
          'store'
        )

        if (stock) {
          await StockService.decrementStock(stock.id, quantity)
        }
      }

      return dispenseLog?.[0] || null
    } catch (err) {
      console.error('Error recording dispense:', err)
      throw err
    }
  }

  /**
   * Get dispense history
   */
  static async getDispenseHistory(facilityId, options = {}) {
    const { dsdSiteName, sdpName, date, limit = 1000, offset = 0 } = options

    let query = sbAdmin
      .from('dispense_log')
      .select('*,commodities(id,name,category,unit)')
      .eq('facility_id', facilityId)
      .order('dispensed_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (dsdSiteName) {
      query = query.eq('dsd_site_name', dsdSiteName)
    } else if (sdpName) {
      query = query.eq('sdp_name', sdpName)
    }

    if (date) {
      // Filter by date (YYYY-MM-DD)
      const startOfDay = `${date}T00:00:00`
      const endOfDay = `${date}T23:59:59`
      query = query.gte('dispensed_at', startOfDay).lte('dispensed_at', endOfDay)
    }

    const { data, error } = await query

    if (error) throw error
    return data || []
  }

  /**
   * Record intake operation
   * Updates stock quantity
   */
  static async recordIntake(intakeData) {
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
      section
    } = intakeData

    if (!facility_id || !commodity_id || !quantity || !received_by) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, received_by')
    }

    try {
      // Record in intake_log
      const { data: intakeLog, error: logError } = await sbAdmin
        .from('intake_log')
        .insert({
          facility_id,
          commodity_id,
          quantity: parseInt(quantity),
          supplier_source: supplier_source || '',
          batch_number: batch_number || '',
          expiry_date: expiry_date || null,
          delivery_note_ref: delivery_note_ref || '',
          condition_on_arrival: condition_on_arrival || 'Good',
          received_by,
          received_at: received_at || new Date().toISOString(),
          notes: notes || '',
          section
        })
        .select()

      if (logError) throw logError

      // Update or create stock
      const existingStock = await StockService.getStockByFacilityAndCommodity(
        facility_id,
        commodity_id,
        'store'
      )

      if (existingStock) {
        await StockService.incrementStock(existingStock.id, quantity)
      } else {
        await StockService.createStock({
          facility_id,
          commodity_id,
          quantity: parseInt(quantity),
          location_type: 'store',
          section
        })
      }

      return intakeLog?.[0] || null
    } catch (err) {
      console.error('Error recording intake:', err)
      throw err
    }
  }

  /**
   * Get intake history
   */
  static async getIntakeHistory(facilityId, options = {}) {
    const { date, supplier_source, limit = 1000, offset = 0 } = options

    let query = sbAdmin
      .from('intake_log')
      .select('*,commodities(id,name,category,unit)')
      .eq('facility_id', facilityId)
      .order('received_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (supplier_source) {
      query = query.eq('supplier_source', supplier_source)
    }

    if (date) {
      // Filter by date (YYYY-MM-DD)
      const startOfDay = `${date}T00:00:00`
      const endOfDay = `${date}T23:59:59`
      query = query.gte('received_at', startOfDay).lte('received_at', endOfDay)
    }

    const { data, error } = await query

    if (error) throw error
    return data || []
  }

  /**
   * Record stock adjustment
   */
  static async recordAdjustment(adjustmentData) {
    const {
      facility_id,
      commodity_id,
      quantity,
      adjustment_type,
      reason,
      adjusted_by,
      reference_number,
      notes,
      adjusted_at,
      expiry_date,
      batch_number,
      section
    } = adjustmentData

    if (!facility_id || !commodity_id || !quantity || !adjustment_type || !reason || !adjusted_by) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, adjustment_type, reason, adjusted_by')
    }

    if (!['Increase', 'Decrease'].includes(adjustment_type)) {
      throw new Error('adjustment_type must be "Increase" or "Decrease"')
    }

    try {
      // Record in stock_adjustment_log
      const { data: adjustmentLog, error: logError } = await sbAdmin
        .from('stock_adjustment_log')
        .insert({
          facility_id,
          commodity_id,
          quantity: parseInt(quantity),
          adjustment_type,
          reason,
          adjusted_by,
          reference_number: reference_number || '',
          notes: notes || '',
          adjusted_at: adjusted_at || new Date().toISOString(),
          expiry_date: expiry_date || null,
          batch_number: batch_number || '',
          section
        })
        .select()

      if (logError) throw logError

      // Update stock quantity
      const stock = await StockService.getStockByFacilityAndCommodity(
        facility_id,
        commodity_id,
        'store'
      )

      if (stock) {
        if (adjustment_type === 'Increase') {
          await StockService.incrementStock(stock.id, quantity)
        } else {
          await StockService.decrementStock(stock.id, quantity)
        }
      } else if (adjustment_type === 'Increase') {
        // Create stock if increasing and doesn't exist
        await StockService.createStock({
          facility_id,
          commodity_id,
          quantity: parseInt(quantity),
          location_type: 'store',
          section
        })
      }

      return adjustmentLog?.[0] || null
    } catch (err) {
      console.error('Error recording adjustment:', err)
      throw err
    }
  }

  /**
   * Get adjustment history
   */
  static async getAdjustmentHistory(facilityId, options = {}) {
    const { date, adjustment_type, reason, limit = 1000, offset = 0 } = options

    let query = sbAdmin
      .from('stock_adjustment_log')
      .select('*,commodities(id,name,category,unit)')
      .eq('facility_id', facilityId)
      .order('adjusted_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (adjustment_type) {
      query = query.eq('adjustment_type', adjustment_type)
    }

    if (reason) {
      query = query.eq('reason', reason)
    }

    if (date) {
      // Filter by date (YYYY-MM-DD)
      const startOfDay = `${date}T00:00:00`
      const endOfDay = `${date}T23:59:59`
      query = query.gte('adjusted_at', startOfDay).lte('adjusted_at', endOfDay)
    }

    const { data, error } = await query

    if (error) throw error
    return data || []
  }
}
