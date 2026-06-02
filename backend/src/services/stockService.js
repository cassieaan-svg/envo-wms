import { sbAdmin } from '../supabase.js'

export class StockService {
  /**
   * Get stock records for a facility
   */
  static async getStock(facilityId, options = {}) {
    const { commodityId, locationType, limit = 1000, offset = 0 } = options

    let query = sbAdmin
      .from('stock')
      .select(
        'id,facility_id,commodity_id,quantity,tablet_buffer,baseline_amc,updated_at,location_type,' +
        'facilities(id,name,state,lga),commodities(id,name,category,unit,dispensing_unit,pack_size,section)'
      )
      .eq('facility_id', facilityId)
      .order('commodities(name)')
      .range(offset, offset + limit - 1)

    if (commodityId) {
      query = query.eq('commodity_id', commodityId)
    }

    if (locationType) {
      query = query.eq('location_type', locationType)
    }

    const { data, error } = await query

    if (error) throw error
    return data || []
  }

  /**
   * Get DSD stock for a facility (all sites or specific site)
   */
  static async getDsdStock(facilityId, options = {}) {
    const { dsdSiteName, limit = 1000, offset = 0 } = options

    let query = sbAdmin
      .from('dsd_stock')
      .select(
        'id,facility_id,dsd_site_name,commodity_id,quantity,updated_at,' +
        'commodities(id,name,category,unit,dispensing_unit,pack_size)'
      )
      .eq('facility_id', facilityId)
      .order('commodities(name)')
      .range(offset, offset + limit - 1)

    if (dsdSiteName) {
      query = query.eq('dsd_site_name', dsdSiteName)
    }

    const { data, error } = await query

    if (error) throw error
    return data || []
  }

  /**
   * Get SDP stock for a facility (all sites or specific site)
   */
  static async getSdpStock(facilityId, options = {}) {
    const { sdpName, limit = 1000, offset = 0 } = options

    let query = sbAdmin
      .from('sdp_stock')
      .select(
        'id,facility_id,sdp_name,commodity_id,quantity,updated_at,' +
        'commodities(id,name,category,unit,dispensing_unit,pack_size)'
      )
      .eq('facility_id', facilityId)
      .order('commodities(name)')
      .range(offset, offset + limit - 1)

    if (sdpName) {
      query = query.eq('sdp_name', sdpName)
    }

    const { data, error } = await query

    if (error) throw error
    return data || []
  }

  /**
   * Create a new stock record
   */
  static async createStock(stockData) {
    const { facility_id, commodity_id, quantity, location_type, section } = stockData

    // Validate inputs
    if (!facility_id || !commodity_id || quantity === undefined || !location_type) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, location_type')
    }

    const { data, error } = await sbAdmin
      .from('stock')
      .insert({
        facility_id,
        commodity_id,
        quantity: parseInt(quantity),
        location_type,
        updated_at: new Date().toISOString()
      })
      .select()

    if (error) throw error
    return data?.[0] || null
  }

  /**
   * Update stock quantity
   */
  static async updateStock(stockId, updateData) {
    const { quantity } = updateData

    if (quantity === undefined) {
      throw new Error('Missing required field: quantity')
    }

    const { data, error } = await sbAdmin
      .from('stock')
      .update({
        quantity: parseInt(quantity),
        updated_at: new Date().toISOString()
      })
      .eq('id', stockId)
      .select()

    if (error) throw error
    return data?.[0] || null
  }

  /**
   * Get stock record by ID with full details
   */
  static async getStockById(stockId) {
    const { data, error } = await sbAdmin
      .from('stock')
      .select(
        'id,facility_id,commodity_id,quantity,tablet_buffer,baseline_amc,updated_at,location_type,' +
        'facilities(id,name),commodities(id,name,category,unit)'
      )
      .eq('id', stockId)
      .single()

    if (error) throw error
    return data
  }

  /**
   * Get stock by facility and commodity
   */
  static async getStockByFacilityAndCommodity(facilityId, commodityId, locationType = 'store') {
    const { data, error } = await sbAdmin
      .from('stock')
      .select('*')
      .eq('facility_id', facilityId)
      .eq('commodity_id', commodityId)
      .eq('location_type', locationType)
      .single()

    // Don't throw if not found, return null
    if (error?.code === 'PGRST116') return null
    if (error) throw error
    return data
  }

  /**
   * Get DSD stock by facility, site, and commodity
   */
  static async getDsdStockByFacilitySiteCommodity(facilityId, dsdSiteName, commodityId) {
    const { data, error } = await sbAdmin
      .from('dsd_stock')
      .select('*')
      .eq('facility_id', facilityId)
      .eq('dsd_site_name', dsdSiteName)
      .eq('commodity_id', commodityId)
      .single()

    // Don't throw if not found, return null
    if (error?.code === 'PGRST116') return null
    if (error) throw error
    return data
  }

  /**
   * Get SDP stock by facility, site, and commodity
   */
  static async getSdpStockByFacilitySiteCommodity(facilityId, sdpName, commodityId) {
    const { data, error } = await sbAdmin
      .from('sdp_stock')
      .select('*')
      .eq('facility_id', facilityId)
      .eq('sdp_name', sdpName)
      .eq('commodity_id', commodityId)
      .single()

    // Don't throw if not found, return null
    if (error?.code === 'PGRST116') return null
    if (error) throw error
    return data
  }

  /**
   * Increment stock quantity
   */
  static async incrementStock(stockId, amount) {
    const stock = await this.getStockById(stockId)
    if (!stock) throw new Error('Stock record not found')

    return this.updateStock(stockId, {
      quantity: stock.quantity + parseInt(amount)
    })
  }

  /**
   * Decrement stock quantity (safely, never goes below 0)
   */
  static async decrementStock(stockId, amount) {
    const stock = await this.getStockById(stockId)
    if (!stock) throw new Error('Stock record not found')

    const newQuantity = Math.max(0, stock.quantity - parseInt(amount))
    return this.updateStock(stockId, { quantity: newQuantity })
  }

  /**
   * Check if commodity exists
   */
  static async commodityExists(commodityId) {
    const { data, error } = await sbAdmin
      .from('commodities')
      .select('id')
      .eq('id', commodityId)
      .maybeSingle()

    if (error) throw error
    return !!data
  }

  /**
   * Check if facility exists
   */
  static async facilityExists(facilityId) {
    const { data, error } = await sbAdmin
      .from('facilities')
      .select('id')
      .eq('id', facilityId)
      .maybeSingle()

    if (error) throw error
    return !!data
  }
}
