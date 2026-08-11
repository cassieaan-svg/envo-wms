import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import { authMiddleware } from './middleware/auth.js';
import { startOutboxWorker } from './lib/outboxWorker.js';
import { serviceAuth } from './middleware/serviceAuth.js';
import authRouter from './routes/auth.js';
import catalogueRouter from './routes/catalogue.js';
import inboundRequestsRouter from './routes/inboundRequests.js';
import requestsRouter from './routes/requests.js';
import vendorsRouter from './routes/vendors.js';
import commoditiesRouter from './routes/commodities.js';
import batchesRouter from './routes/batches.js';
import dispatchOrdersRouter from './routes/dispatchOrders.js';
import alertsRouter from './routes/alerts.js';
import monitoringRouter from './routes/monitoring.js';
import syncRouter from './routes/sync.js';
import facilitiesRouter from './routes/facilities.js';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// Login is public; the catalogue export is server-to-server (service token). Both are
// registered before the user-JWT layer so they don't require a WMS user login.
app.use('/api/auth', authRouter);
app.use('/api/catalogue', serviceAuth, catalogueRouter);
app.use('/inbound/requests', serviceAuth, inboundRequestsRouter);
app.use('/api', authMiddleware);

app.use('/api/requests', requestsRouter);

app.use('/api/vendors', vendorsRouter);
app.use('/api/commodities', commoditiesRouter);
app.use('/api/batches', batchesRouter);
app.use('/api/dispatch-orders', dispatchOrdersRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/monitoring', monitoringRouter);
app.use('/api/sync', syncRouter);
// Facility CRUD, its commodity assignments, stock proxy and dispatch-order history all
// hang off /api/facilities.
app.use('/api/facilities', facilitiesRouter);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.expose === false ? 'internal error' : err.message });
});

const port = Number(process.env.PORT || 5000);
app.listen(port, () => {
  console.log(`EnVo WMS backend listening on :${port}`);
  // Delivers queued EnVo callbacks, including any left pending by a previous run.
  startOutboxWorker();
});

export default app;
