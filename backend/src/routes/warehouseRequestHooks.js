import express from 'express'
import { WarehouseRequestService } from '../services/warehouseRequestService.js'

const router = express.Router()

// Service-to-service status callback from the WMS (mounted under /hooks with serviceAuth,
// outside the user-JWT layer). The WMS calls this as a request moves through picking /
// dispatched, echoing back our envoRequestId.
//
// POST /hooks/warehouse-requests/status
//   { envoRequestId, wmsRequestId?, status, totalAmount?, reason?, items?:[{ wmsCommodityId, qtyDispatched }] }
router.post('/status', async (req, res) => {
  try {
    const { envoRequestId, wmsRequestId, status, totalAmount, reason, items } = req.body || {}
    if (!envoRequestId || !status) {
      return res.status(400).json({ success: false, error: 'envoRequestId and status are required' })
    }
    // 'cancelled' = the warehouse rejected the request (out of stock, etc.); the facility
    // then re-requests. It's terminal, like received.
    const allowed = ['submitted', 'picking', 'dispatched', 'cancelled']
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, error: `Unsupported status: ${status}` })
    }
    const updated = await WarehouseRequestService.applyWmsStatus({ envoRequestId, wmsRequestId, status, totalAmount, reason, items })
    res.json({ success: true, data: updated })
  } catch (err) {
    const status = err.status || 500
    if (status >= 500) console.error('Error applying WMS status:', err)
    res.status(status).json({ success: false, error: err.message })
  }
})

export default router
