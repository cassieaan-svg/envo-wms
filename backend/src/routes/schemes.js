import express from 'express'
import { query } from '../db.js'

const router = express.Router()

// Funding schemes for Essential Commodities (DRF / BHCPF / Health Insurance).
// Auth + scope are applied globally to /api (server.js).

/**
 * GET /api/schemes — the active funding schemes, for the request form's picker.
 *
 * Served from the table rather than a constant in the client, so adding a fund is a
 * database insert and every screen picks it up. `creates_debt` travels with each row
 * so the form can warn that a DRF order will be billed to the facility, without the
 * client hardcoding which fund that is.
 */
router.get('/', async (_req, res) => {
  try {
    const { rows } = await query(
      'select key, label, creates_debt from schemes where active order by sort_order, label')
    res.json({ success: true, data: rows, count: rows.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching schemes:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

export default router
