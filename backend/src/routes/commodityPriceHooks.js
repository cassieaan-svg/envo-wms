import express from 'express'
import { query } from '../db.js'

const router = express.Router()

// Service-to-service: the WMS pushes a price change here so EnVo's essential catalogue
// display price (commodities.unit_price) stays live without a full re-sync. Mounted under
// /hooks with serviceAuth (outside the user-JWT layer).
//
// POST /hooks/commodities/price   { wmsCommodityId, unitPrice }
router.post('/price', async (req, res) => {
  try {
    const { wmsCommodityId, unitPrice } = req.body || {}
    if (wmsCommodityId == null || unitPrice == null || Number.isNaN(Number(unitPrice))) {
      return res.status(400).json({ success: false, error: 'wmsCommodityId and unitPrice are required' })
    }
    const { rowCount } = await query(
      `update commodities set unit_price = $2
        where wms_commodity_id = $1 and module = 'essential'`,
      [Number(wmsCommodityId), Number(unitPrice)]
    )
    res.json({ success: true, updated: rowCount })
  } catch (err) {
    console.error('commodity price hook error:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

export default router
