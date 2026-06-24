import express from 'express'
import { CommodityService } from '../services/commodityService.js'

const router = express.Router()

// Auth applied globally to /api (server.js). commodities RLS read = public (any
// authenticated), with no write policy — this GET route needs only auth.

/**
 * GET /api/commodities - List all commodities (ordered category -> name)
 */
router.get('/', async (req, res) => {
  try {
    const commodities = await CommodityService.getCommodities()

    res.json({
      success: true,
      data: commodities,
      count: commodities.length,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('Error fetching commodities:', err)
    res.status(500).json({
      success: false,
      error: err.message,
      code: 'FETCH_ERROR'
    })
  }
})

export default router
