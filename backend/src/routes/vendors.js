import express from 'express';
import { VendorService } from '../services/vendorService.js';
import { requirePermission } from '../middleware/requirePermission.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const vendors = await VendorService.list({ includeInactive: req.query.includeInactive === 'true' });
    return res.json(vendors);
  } catch (err) {
    return next(err);
  }
});

router.post('/', requirePermission('vendors.manage'), async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const vendor = await VendorService.create(req.body);
    return res.status(201).json(vendor);
  } catch (err) {
    return next(err);
  }
});

router.put('/:id', requirePermission('vendors.manage'), async (req, res, next) => {
  try {
    const vendor = await VendorService.update(Number(req.params.id), req.body || {});
    if (!vendor) return res.status(404).json({ error: 'vendor not found' });
    return res.json(vendor);
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', requirePermission('vendors.manage'), async (req, res, next) => {
  try {
    const vendor = await VendorService.deactivate(Number(req.params.id));
    if (!vendor) return res.status(404).json({ error: 'vendor not found' });
    return res.json(vendor);
  } catch (err) {
    return next(err);
  }
});

export default router;
