import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// Server-to-server export of the catalogue master, for EnVo to seed / sync its
// Essential Commodities module from. Service-token auth (mounted before the user JWT
// layer in server.js). Returns every commodity with its current price (null when
// unpriced) and the facility roster keyed by envo_facility_id so EnVo can enroll the
// matching facilities into the essential module.
router.get('/export', async (req, res) => {
  try {
    const commodities = (await query(
      `SELECT c.id AS wms_commodity_id, c.name, c.category, c.unit, c.is_active,
              p.unit_price
         FROM commodities c
         LEFT JOIN commodity_prices p ON p.commodity_id = c.id AND p.is_current
        ORDER BY c.category, c.name`
    )).rows;

    const facilities = (await query(
      `SELECT envo_facility_id, name, state, lga
         FROM facilities
        WHERE is_active
        ORDER BY name`
    )).rows;

    res.json({ commodities, facilities });
  } catch (err) {
    console.error('catalogue export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
