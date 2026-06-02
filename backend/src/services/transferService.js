import { sbAdmin } from '../supabase.js'
import { StockService } from './stockService.js'

export class TransferService {
  /**
   * Get transfers for a facility
   */
  static async getTransfers(facilityId, options = {}) {
    const { status, type = 'all', limit = 1000, offset = 0 } = options

    let query = sbAdmin
      .from('stock_transfer_log')
      .select('*,commodities(id,name,category,unit),facilities(id,name)')
      .order('initiated_at', { ascending: false })
      .range(offset, offset + limit - 1)

    // Filter by facility (incoming or outgoing)
    if (type === 'incoming') {
      query = query.eq('receiving_facility_id', facilityId)
    } else if (type === 'outgoing') {
      query = query.eq('sending_facility_id', facilityId)
    } else {
      // all = incoming + outgoing
      query = query.or(`receiving_facility_id.eq.${facilityId},sending_facility_id.eq.${facilityId}`)
    }

    // Filter by status if provided
    if (status) {
      query = query.eq('status', status)
    }

    const { data, error } = await query

    if (error) throw error
    return data || []
  }

  /**
   * Get single transfer with details
   */
  static async getTransferById(transferId) {
    const { data, error } = await sbAdmin
      .from('stock_transfer_log')
      .select('*,commodities(id,name,category,unit),facilities(id,name)')
      .eq('id', transferId)
      .single()

    if (error?.code === 'PGRST116') return null
    if (error) throw error
    return data
  }

  /**
   * Create transfer request
   * Supports multiple line items
   */
  static async createTransfer(transferData) {
    const {
      lines,
      receiving_facility_id,
      sending_facility_id,
      transfer_type,
      notes,
      initiated_by,
      section
    } = transferData

    if (!lines || lines.length === 0) {
      throw new Error('At least one line item required')
    }

    if (!transfer_type) {
      throw new Error('transfer_type is required')
    }

    // Prepare payloads for all lines
    const payloads = lines.map(line => ({
      sending_facility_id: sending_facility_id || null,
      receiving_facility_id: receiving_facility_id || null,
      commodity_id: line.commodity_id,
      quantity: parseInt(line.quantity),
      qty_requested: parseInt(line.qty_requested || line.quantity),
      status: this._getInitialStatus(transfer_type),
      transfer_type,
      notes: notes || '',
      initiated_by,
      initiated_at: new Date().toISOString(),
      section
    }))

    // Batch insert all lines
    const { data, error } = await sbAdmin
      .from('stock_transfer_log')
      .insert(payloads)
      .select()

    if (error) throw error
    return data || []
  }

  /**
   * Approve transfer (complex operation with stock updates)
   */
  static async approveTransfer(transferId, approvalData) {
    const { approved_by, notes, facility_assignment } = approvalData

    // Get transfer details
    const transfer = await this.getTransferById(transferId)
    if (!transfer) throw new Error('Transfer not found')

    // Determine if this is a DSD/SDP request that needs facility assignment
    const needsFacilityAssignment = ['dsd', 'sdp'].includes(transfer.transfer_type)
    if (needsFacilityAssignment && !facility_assignment) {
      throw new Error(`${transfer.transfer_type.toUpperCase()} transfer requires facility_assignment`)
    }

    const issuedQuantity = parseInt(approvalData.quantity || transfer.quantity)

    try {
      // Update transfer status
      const updatePayload = {
        status: transfer.transfer_type === 'dsd' || transfer.transfer_type === 'sdp'
          ? 'in_transit'
          : 'in_transit',
        resolved_by: approved_by,
        resolved_at: new Date().toISOString()
      }

      if (notes) updatePayload.notes = transfer.notes + ` [Approved: ${notes}]`

      const { data: updatedTransfer, error: updateError } = await sbAdmin
        .from('stock_transfer_log')
        .update(updatePayload)
        .eq('id', transferId)
        .select()

      if (updateError) throw updateError

      // Deduct from sender stock if applicable
      if (transfer.sending_facility_id) {
        const senderStock = await StockService.getStockByFacilityAndCommodity(
          transfer.sending_facility_id,
          transfer.commodity_id,
          'store'
        )

        if (senderStock) {
          await StockService.decrementStock(senderStock.id, issuedQuantity)
        }
      }

      // Add to receiver stock or DSD/SDP stock
      if (transfer.receiving_facility_id && transfer.transfer_type !== 'dsd' && transfer.transfer_type !== 'sdp') {
        const receiverStock = await StockService.getStockByFacilityAndCommodity(
          transfer.receiving_facility_id,
          transfer.commodity_id,
          'store'
        )

        if (receiverStock) {
          await StockService.incrementStock(receiverStock.id, issuedQuantity)
        } else {
          await StockService.createStock({
            facility_id: transfer.receiving_facility_id,
            commodity_id: transfer.commodity_id,
            quantity: issuedQuantity,
            location_type: 'store',
            section: transfer.section
          })
        }
      } else if (transfer.transfer_type === 'dsd') {
        // Update DSD stock
        const dsdSiteName = facility_assignment || transfer.receiving_facility_name
        const dsdStock = await StockService.getDsdStockByFacilitySiteCommodity(
          transfer.sending_facility_id,
          dsdSiteName,
          transfer.commodity_id
        )

        if (dsdStock) {
          await sbAdmin
            .from('dsd_stock')
            .update({
              quantity: dsdStock.quantity + issuedQuantity,
              updated_at: new Date().toISOString()
            })
            .eq('id', dsdStock.id)
        } else {
          await sbAdmin
            .from('dsd_stock')
            .insert({
              facility_id: transfer.sending_facility_id,
              dsd_site_name: dsdSiteName,
              commodity_id: transfer.commodity_id,
              quantity: issuedQuantity,
              updated_at: new Date().toISOString()
            })
        }
      } else if (transfer.transfer_type === 'sdp') {
        // Update SDP stock
        const sdpName = facility_assignment || transfer.receiving_facility_name
        const sdpStock = await StockService.getSdpStockByFacilitySiteCommodity(
          transfer.sending_facility_id,
          sdpName,
          transfer.commodity_id
        )

        if (sdpStock) {
          await sbAdmin
            .from('sdp_stock')
            .update({
              quantity: sdpStock.quantity + issuedQuantity,
              updated_at: new Date().toISOString()
            })
            .eq('id', sdpStock.id)
        } else {
          await sbAdmin
            .from('sdp_stock')
            .insert({
              facility_id: transfer.sending_facility_id,
              sdp_name: sdpName,
              commodity_id: transfer.commodity_id,
              quantity: issuedQuantity,
              updated_at: new Date().toISOString()
            })
        }
      }

      return updatedTransfer?.[0] || null
    } catch (err) {
      console.error('Error approving transfer:', err)
      throw err
    }
  }

  /**
   * Accept transfer (receiver side)
   */
  static async acceptTransfer(transferId, acceptanceData) {
    const { accepted_by, notes } = acceptanceData

    const transfer = await this.getTransferById(transferId)
    if (!transfer) throw new Error('Transfer not found')

    try {
      // Add to receiver stock
      const receiverStock = await StockService.getStockByFacilityAndCommodity(
        transfer.receiving_facility_id,
        transfer.commodity_id,
        'store'
      )

      if (receiverStock) {
        await StockService.incrementStock(receiverStock.id, transfer.quantity)
      } else {
        await StockService.createStock({
          facility_id: transfer.receiving_facility_id,
          commodity_id: transfer.commodity_id,
          quantity: transfer.quantity,
          location_type: 'store',
          section: transfer.section
        })
      }

      // Record intake log
      await sbAdmin
        .from('intake_log')
        .insert({
          facility_id: transfer.receiving_facility_id,
          commodity_id: transfer.commodity_id,
          quantity: transfer.quantity,
          supplier_source: transfer.sending_facility_id || transfer.sending_facility_name,
          received_by: accepted_by,
          received_at: new Date().toISOString(),
          notes: `Transfer from ${transfer.sending_facility_name || 'Unknown'}. ${notes || ''}`,
          section: transfer.section
        })

      // Update transfer status
      const { data, error } = await sbAdmin
        .from('stock_transfer_log')
        .update({
          status: 'accepted',
          resolved_at: new Date().toISOString(),
          resolved_by: accepted_by
        })
        .eq('id', transferId)
        .select()

      if (error) throw error
      return data?.[0] || null
    } catch (err) {
      console.error('Error accepting transfer:', err)
      throw err
    }
  }

  /**
   * Cancel transfer
   */
  static async cancelTransfer(transferId, cancellationData) {
    const { cancelled_by, reason } = cancellationData

    const transfer = await this.getTransferById(transferId)
    if (!transfer) throw new Error('Transfer not found')

    try {
      // If transfer was already in transit, return stock to sender
      if (transfer.status === 'in_transit' && transfer.sending_facility_id) {
        const senderStock = await StockService.getStockByFacilityAndCommodity(
          transfer.sending_facility_id,
          transfer.commodity_id,
          'store'
        )

        if (senderStock) {
          await StockService.incrementStock(senderStock.id, transfer.quantity)
        }
      }

      // Update transfer status
      const { data, error } = await sbAdmin
        .from('stock_transfer_log')
        .update({
          status: 'cancelled',
          resolved_at: new Date().toISOString(),
          resolved_by: cancelled_by,
          notes: transfer.notes + ` [Cancelled: ${reason}]`
        })
        .eq('id', transferId)
        .select()

      if (error) throw error
      return data?.[0] || null
    } catch (err) {
      console.error('Error cancelling transfer:', err)
      throw err
    }
  }

  /**
   * Get initial status based on transfer type
   */
  static _getInitialStatus(transferType) {
    const statusMap = {
      'request_for_redistribution': 'pending',
      'external_redistribution': 'in_transit',
      'internal': 'pending_approval',
      'dsd': 'pending_approval',
      'sdp': 'pending_approval'
    }
    return statusMap[transferType] || 'pending'
  }
}
