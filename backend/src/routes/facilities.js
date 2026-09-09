import express from 'express';
import { FacilityService } from '../services/facilityService.js';
import { DispatchService } from '../services/dispatchService.js';
import { fetchEnvoStock } from '../lib/envoClient.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { IdempotencyService } from '../services/idempotencyService.js';
import { query } from '../db.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const facilities = await FacilityService.list({
      state: req.query.state || null,
      lga: req.query.lga || null,
      search: req.query.search || null,
      facilityType: req.query.facilityType || null,
      includeInactive: req.query.includeInactive === 'true',
    });
    return res.json(facilities);
  } catch (err) {
    return next(err);
  }
});

// Registered before /:id so "lgas" isn't parsed as a facility id.
router.get('/lgas', async (req, res, next) => {
  try {
    return res.json(await FacilityService.listLgas({ state: req.query.state || null }));
  } catch (err) {
    return next(err);
  }
});

router.post('/', requirePermission('facilities.manage'), async (req, res, next) => {
  try {
    const { name, state } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!state?.trim()) return res.status(400).json({ error: 'state is required' });

    return res.status(201).json(await FacilityService.create(req.body));
  } catch (err) {
    return next(err);
  }
});

router.put('/:id', requirePermission('facilities.manage'), async (req, res, next) => {
  try {
    const facility = await FacilityService.update(Number(req.params.id), req.body || {});
    if (!facility) return res.status(404).json({ error: 'facility not found' });
    return res.json(facility);
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/commodities', async (req, res, next) => {
  try {
    return res.json(await FacilityService.listCommodities(Number(req.params.id)));
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/commodities', requirePermission('facilities.assignCommodities'), async (req, res, next) => {
  try {
    const facilityId = Number(req.params.id);
    const { commodityId, commodityIds, isDefault } = req.body || {};

    if (Array.isArray(commodityIds)) {
      const added = await FacilityService.addCommodities(facilityId, commodityIds.map(Number), {
        isDefault: Boolean(isDefault),
        addedBy: req.user.username,
      });
      return res.status(201).json({ added });
    }

    if (!commodityId) return res.status(400).json({ error: 'commodityId or commodityIds is required' });

    const row = await FacilityService.addCommodity(facilityId, {
      commodityId: Number(commodityId),
      isDefault: Boolean(isDefault),
      addedBy: req.user.username,
    });
    if (!row) return res.status(409).json({ error: 'commodity is already assigned to this facility' });
    return res.status(201).json(row);
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'unknown facilityId or commodityId' });
    return next(err);
  }
});

router.delete('/:id/commodities/:commodityId', requirePermission('facilities.assignCommodities'), async (req, res, next) => {
  try {
    const removed = await FacilityService.removeCommodity(
      Number(req.params.id),
      Number(req.params.commodityId)
    );
    if (!removed) return res.status(404).json({ error: 'assignment not found' });
    return res.json({ removed: true });
  } catch (err) {
    return next(err);
  }
});

// Multi-line dispatch: several commodities, each with its own quantity and price.
router.post('/:id/dispatch-orders', requirePermission('dispatchOrders.edit'), async (req, res, next) => {
  try {
    const { items, notes } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items must be a non-empty array' });
    }

    for (const [index, item] of items.entries()) {
      if (!item?.commodityId) {
        return res.status(400).json({ error: `items[${index}].commodityId is required` });
      }
      if (!(Number(item.quantity) > 0)) {
        return res.status(400).json({ error: `items[${index}].quantity must be greater than zero` });
      }
      if (item.unitPrice == null || !(Number(item.unitPrice) >= 0)) {
        return res.status(400).json({ error: `items[${index}].unitPrice must be a non-negative number` });
      }
    }

    const duplicates = items.length !== new Set(items.map((i) => Number(i.commodityId))).size;
    if (duplicates) {
      return res.status(400).json({ error: 'each commodity may only appear once per order' });
    }

    const order = await DispatchService.createOrder({
      facilityId: Number(req.params.id),
      items,
      notes: notes || null,
      // The person who actually issued the stock, as typed on the form. Store logins
      // are shared, so stamping the account name says nothing about who handed it over.
      dispatchedBy: (typeof req.body?.dispatchedBy === 'string' && req.body.dispatchedBy.trim())
        || req.user?.fullName || req.user?.username || null,
      scheme: req.body?.scheme,   // the fund this direct issue is made against
      // Optional: a retry carrying the same id returns the original order rather than
      // drawing the stock a second time.
      clientTxnId: IdempotencyService.require(req.body?.clientTxnId),
      actorUserId: req.user.id,
    });
    return res.status(201).json(order);
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/dispatch-orders', async (req, res, next) => {
  try {
    return res.json(await DispatchService.listForFacility(Number(req.params.id)));
  } catch (err) {
    return next(err);
  }
});

// Proxied from EnVo — mock data until the real API details are confirmed.
router.get('/:id/stock', async (req, res, next) => {
  const facilityId = Number(req.params.id);
  try {
    const facilities = await FacilityService.list({ includeInactive: true });
    const facility = facilities.find((f) => f.id === facilityId);
    if (!facility) return res.status(404).json({ error: 'facility not found' });

    try {
      const stock = await fetchEnvoStock(facility.envo_facility_id || facility.id);
      await query(
        `INSERT INTO facility_stock_cache (facility_id, payload, fetched_at)
              VALUES ($1, $2, now())
         ON CONFLICT (facility_id)
         DO UPDATE SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at`,
        [facilityId, JSON.stringify(stock)]
      );
      return res.json({ ...stock, stale: false, asOf: new Date().toISOString() });
    } catch (err) {
      // EnVo is unreachable. Serve the last good answer if we have one, labelled stale,
      // and only fail outright when this facility has never been fetched successfully.
      const { rows } = await query(
        'SELECT payload, fetched_at FROM facility_stock_cache WHERE facility_id = $1',
        [facilityId]
      );
      if (!rows[0]) {
        return res.status(502).json({ error: `could not reach EnVo: ${err.message}` });
      }
      return res.json({
        ...rows[0].payload,
        stale: true,
        asOf: rows[0].fetched_at,
        staleReason: err.message,
      });
    }
  } catch (err) {
    return next(err);
  }
});

export default router;
