import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// Funding schemes (DRF / BHCPF / Health Insurance). Served from the table so adding a
// fund is a database insert and both the dispatch UI and EnVo's request form pick it
// up without a code change. `creates_debt` travels with each row so no screen has to
// hardcode which fund bills the facility.
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT key, label, creates_debt FROM schemes WHERE active ORDER BY sort_order, label'
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

export default router;
