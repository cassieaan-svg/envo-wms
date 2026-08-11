import express from 'express';
import { MonitoringService } from '../services/monitoringService.js';

const router = express.Router();

// Every endpoint here takes the same optional ?from=&to= ISO date window. The dashboard
// endpoints additionally honour ?lga= and ?category=; the drill-downs ignore them.
function period(req) {
  return {
    from: req.query.from || null,
    to: req.query.to || null,
    lga: req.query.lga || null,
    category: req.query.category || null,
  };
}

router.get('/summary', async (req, res, next) => {
  try {
    return res.json(await MonitoringService.summary(period(req)));
  } catch (err) {
    return next(err);
  }
});

router.get('/daily', async (req, res, next) => {
  try {
    return res.json(await MonitoringService.daily(period(req)));
  } catch (err) {
    return next(err);
  }
});

router.get('/by-category', async (req, res, next) => {
  try {
    return res.json(await MonitoringService.byCategory(period(req)));
  } catch (err) {
    return next(err);
  }
});

router.get('/by-facility', async (req, res, next) => {
  try {
    return res.json(await MonitoringService.byFacility(period(req)));
  } catch (err) {
    return next(err);
  }
});

router.get('/by-commodity', async (req, res, next) => {
  try {
    return res.json(await MonitoringService.byCommodity(period(req)));
  } catch (err) {
    return next(err);
  }
});

// Registered before /commodities/:id so the two do not collide.
router.get('/commodities/:id/history', async (req, res, next) => {
  try {
    return res.json(
      await MonitoringService.commodityHistory(Number(req.params.id), { limit: req.query.limit })
    );
  } catch (err) {
    return next(err);
  }
});

router.get('/commodities/:id', async (req, res, next) => {
  try {
    return res.json(await MonitoringService.commodityDetail(Number(req.params.id), period(req)));
  } catch (err) {
    return next(err);
  }
});

// One day's records for one kind of operation, feeding the shared history card.
router.get('/day', async (req, res, next) => {
  try {
    return res.json(
      await MonitoringService.dayRecords({ date: req.query.date || null, kind: req.query.kind })
    );
  } catch (err) {
    return next(err);
  }
});

// Adjustments only, with per-reason totals for the period.
router.get('/adjustments', async (req, res, next) => {
  try {
    return res.json(
      await MonitoringService.adjustments({
        from: req.query.from || null,
        to: req.query.to || null,
        reason: req.query.reason || null,
        direction: req.query.direction || null,
        createdBy: req.query.createdBy || null,
      })
    );
  } catch (err) {
    return next(err);
  }
});

// Stock movement log — receipts, dispatches, adjustments and dispatch reversals.
router.get('/activity', async (req, res, next) => {
  try {
    return res.json(
      await MonitoringService.activity({
        ...period(req),
        type: req.query.type,
        limit: req.query.limit,
      })
    );
  } catch (err) {
    return next(err);
  }
});

// What a facility has taken over a period — commodities received and every dispatch,
// across both the ad-hoc and request-fulfilment routes. ?from=&to= are ISO dates and
// default to the last 30 days.
router.get('/facilities/:id', async (req, res, next) => {
  try {
    const detail = await MonitoringService.facilityDetail(Number(req.params.id), {
      from: req.query.from || null,
      to: req.query.to || null,
    });
    return res.json(detail);
  } catch (err) {
    return next(err);
  }
});

export default router;
