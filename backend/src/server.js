import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';

import { authMiddleware } from './middleware/auth.js';
import { startOutboxWorker } from './lib/outboxWorker.js';
import { startSyncWorker } from './lib/syncWorker.js';
import { syncAuth } from './middleware/syncAuth.js';
import { IS_CLOUD, IS_CMS, describeRole } from './lib/role.js';
import { startReconciliationWorker } from './lib/reconciliationWorker.js';
import { serviceAuth } from './middleware/serviceAuth.js';
import authRouter from './routes/auth.js';
import catalogueRouter from './routes/catalogue.js';
import inboundRequestsRouter from './routes/inboundRequests.js';
import inboundBalancesRouter from './routes/inboundBalances.js';
import requestsRouter from './routes/requests.js';
import schemesRouter from './routes/schemes.js';
import accountsRouter from './routes/accounts.js';
import vendorsRouter from './routes/vendors.js';
import commoditiesRouter from './routes/commodities.js';
import batchesRouter from './routes/batches.js';
import dispatchOrdersRouter from './routes/dispatchOrders.js';
import alertsRouter from './routes/alerts.js';
import monitoringRouter from './routes/monitoring.js';
import syncRouter from './routes/sync.js';
import facilitiesRouter from './routes/facilities.js';
import reconciliationRouter from './routes/reconciliation.js';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ...describeRole() }));

// Login is public; the catalogue export is server-to-server (service token). Both are
// registered before the user-JWT layer so they don't require a WMS user login.
app.use('/api/auth', authRouter);
// EnVo integration is Cloud's relationship. On CMS these are not mounted at all, so a
// misconfigured warehouse cannot reach EnVo even by accident — the route simply is not there.
if (IS_CLOUD) {
  app.use('/api/catalogue', serviceAuth, catalogueRouter);
  app.use('/inbound/requests', serviceAuth, inboundRequestsRouter);
  app.use('/inbound', serviceAuth, inboundBalancesRouter);

  // The CMS-facing half of the sync: master data down, transaction envelopes up. Behind the
  // sync token, mounted before the user-JWT layer because the caller is a server.
  app.use('/sync', syncAuth, syncRouter);
}
app.use('/api', authMiddleware);

app.use('/api/requests', requestsRouter);

app.use('/api/schemes', schemesRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/vendors', vendorsRouter);
app.use('/api/commodities', commoditiesRouter);
app.use('/api/batches', batchesRouter);
app.use('/api/dispatch-orders', dispatchOrdersRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/monitoring', monitoringRouter);
app.use('/api/sync', syncRouter);
app.use('/api/reconciliation', reconciliationRouter);
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

// Listen only when this file IS the program. Importing the app — which the route tests do,
// so they exercise the real middleware stack — should not bind a port or start delivering
// callbacks to EnVo as a side effect. `npm start` and `npm run dev` both run this file
// directly and are unaffected.
const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const port = Number(process.env.PORT || 5000);
  app.listen(port, () => {
    console.log(`EnVo WMS backend listening on :${port}`);
    // Delivers queued callbacks and, on CMS, transaction envelopes — including anything
    // left pending by a previous run.
    startOutboxWorker();
    // Finds ledger drift on a timer instead of waiting for someone to ask.
    startReconciliationWorker();
    // CMS only: pull master data and requests from Cloud, push transactions up.
    startSyncWorker();
  });
}

export default app;
