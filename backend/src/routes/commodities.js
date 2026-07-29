import express from 'express';
import { CommodityService } from '../services/commodityService.js';
import { PriceService } from '../services/priceService.js';
import { BatchService } from '../services/batchService.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const commodities = await CommodityService.list({
      category: req.query.category || null,
      search: req.query.search || null,
      includeInactive: req.query.includeInactive === 'true',
    });
    return res.json(commodities);
  } catch (err) {
    return next(err);
  }
});

router.get('/categories', async (req, res, next) => {
  try {
    return res.json(await CommodityService.listCategories());
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const commodity = await CommodityService.getById(Number(req.params.id));
    if (!commodity) return res.status(404).json({ error: 'commodity not found' });
    return res.json(commodity);
  } catch (err) {
    return next(err);
  }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const commodity = await CommodityService.create(req.body);
    return res.status(201).json(commodity);
  } catch (err) {
    return next(err);
  }
});

router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const commodity = await CommodityService.update(Number(req.params.id), req.body || {});
    if (!commodity) return res.status(404).json({ error: 'commodity not found' });
    return res.json(commodity);
  } catch (err) {
    return next(err);
  }
});

router.put('/:id/stock-levels', requireAdmin, async (req, res, next) => {
  try {
    const { reorderLevel, maxLevel } = req.body || {};
    if (reorderLevel != null && maxLevel != null && Number(reorderLevel) > Number(maxLevel)) {
      return res.status(400).json({ error: 'reorderLevel cannot exceed maxLevel' });
    }

    const commodity = await CommodityService.setStockLevels(Number(req.params.id), { reorderLevel, maxLevel });
    if (!commodity) return res.status(404).json({ error: 'commodity not found' });
    return res.json(commodity);
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/prices', async (req, res, next) => {
  try {
    return res.json(await PriceService.history(Number(req.params.id)));
  } catch (err) {
    return next(err);
  }
});

router.put('/:id/prices', requireAdmin, async (req, res, next) => {
  try {
    const { vendorId, unitPrice, brandName, effectiveDate } = req.body || {};
    if (!vendorId) return res.status(400).json({ error: 'vendorId is required' });
    if (unitPrice == null || Number.isNaN(Number(unitPrice)) || Number(unitPrice) < 0) {
      return res.status(400).json({ error: 'unitPrice must be a non-negative number' });
    }

    const price = await PriceService.setCurrentPrice(Number(req.params.id), {
      vendorId: Number(vendorId),
      brandName: brandName || null,
      unitPrice: Number(unitPrice),
      effectiveDate: effectiveDate || null,
      createdBy: req.user.username,
    });
    return res.status(201).json(price);
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/batches', async (req, res, next) => {
  try {
    const batches = await BatchService.listForCommodity(Number(req.params.id), {
      includeDepleted: req.query.includeDepleted === 'true',
    });
    return res.json(batches);
  } catch (err) {
    return next(err);
  }
});

export default router;
