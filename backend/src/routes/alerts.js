import express from 'express';
import { AlertService } from '../services/alertService.js';

const router = express.Router();

router.get('/expiry', async (req, res, next) => {
  try {
    const withinDays = Number(req.query.withinDays ?? 90);
    if (!Number.isFinite(withinDays) || withinDays < 0) {
      return res.status(400).json({ error: 'withinDays must be a non-negative number' });
    }
    return res.json(await AlertService.expiry({ withinDays }));
  } catch (err) {
    return next(err);
  }
});

router.get('/stock', async (req, res, next) => {
  try {
    return res.json(await AlertService.stock());
  } catch (err) {
    return next(err);
  }
});

export default router;
