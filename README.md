# EnVo WMS

Warehouse management for a central medical store that supplies health facilities. Part of the
EnVo product family, but a standalone application: its own repo, its own Postgres database and
its own logins. It talks to EnVo only over REST.

The catalogue is seeded from the Ministry of Health
Central Medical Stores (Uyo) price list and covers tablets, injections, syrups, infusions,
consumables and ophthalmic preparations.

## What it does

- **Vendors** — suppliers that commodities are priced and received against (soft delete only).
- **Commodities & prices** — catalogue grouped by category, with the current price per
  vendor/brand. Prices are versioned: setting a new price marks the old row `is_current = false`
  and inserts a new one, so history is never overwritten.
- **Batches** — lot-level stock with expiry dates and an append-only movement ledger, so every
  quantity change is traceable.
- **Dispatch** — send several commodities to a facility in one order with a quantity and price
  per line and a computed total. Each line is filled FEFO (soonest expiry first) across batches;
  if any line is short, the whole order rolls back.
- **Alerts** — batches at or near expiry, plus commodities below their reorder level or above
  their maximum.
- **Facility stock** — proxied from EnVo. Currently a clearly-marked stub returning mock data.

## Setup

Requires Node 18+ and a local Postgres.

```bash
createdb envo_wms
cd backend && npm install && cp .env.example .env   # then fill in PG* and JWT_SECRET
npm run migrate
npm run create-admin -- <username> <password> admin "Full Name"
npm run dev
```

```bash
cd frontend && npm install && cp .env.example .env  # VITE_API_URL should match the backend PORT
npm run dev
```

The backend defaults to port **5100** to stay clear of EnVo's own backend on 5000.

## Layout

```
backend/
  migrations/       numbered .sql files, applied by scripts/migrate.mjs
  scripts/          migrate.mjs, createAdminUser.mjs
  src/
    db.js           pg Pool + query() + withTransaction()
    middleware/     auth.js (JWT), requireAdmin.js
    services/       all SQL lives here
    routes/         thin Express routers
    lib/            envoClient.js (stubbed, with retry), priceListParser.js
frontend/
  src/pages/        one page per tab
  src/components/   shared UI, price history modal, import preview, dispatch line editor
  src/lib/api.js    fetch client, JWT in localStorage
```

## Auth

WMS-only accounts in its own `users` table (bcrypt + JWT), deliberately separate from EnVo's
`@envo.ng` logins. Two roles: `admin` and `standard`. Reads are open to any signed-in user;
every write that touches prices, batches, dispatch, stock thresholds or facility assignments
requires `admin`.

## Wiring in the real EnVo stock API

`backend/src/lib/envoClient.js` has one `fetchEnvoStock()` function marked with a TODO. Replace
the mock return with the real `fetch` (the commented-out block shows the shape) and set
`ENVO_API_URL` / `ENVO_API_TOKEN`. The `retry()` wrapper — 3 attempts, 3s apart, for field
network timeouts — already surrounds it, and no route needs to change.
