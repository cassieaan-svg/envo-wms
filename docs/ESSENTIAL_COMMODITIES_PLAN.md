# Essential Commodities — Implementation Plan

Cross-repo plan for adding a second module (**Essential Commodities**) to EnVo, with facility-raised
priced requests fulfilled by the EnVo WMS (this repo). Confirmed design, 2026-07-31.

- **EnVo** = `inventory-tracker` (facility-facing app, Postgres, backend `:5000`). Owns modules,
  monitoring, and the request object.
- **WMS** = `envo-wms` (this repo, backend `:5100`). Catalogue/price master; picks, prices, dispatches.
- The two are separate apps/DBs/logins that talk only over REST.

## Confirmed decisions

1. **Option B** — the request lives in EnVo, raised by the **facility** (no envo-admin approval step).
   On submit it POSTs to the WMS and "lands on the warehouse."
2. **WMS is the catalogue + price master.** EnVo's essential catalogue is seeded from the WMS; each
   EnVo essential commodity carries a `wms_commodity_id`. Price shown in EnVo is a synced value; the
   WMS recomputes the authoritative total on the pick order.
3. **Facility confirms receipt** to credit its essential stock (manual, mirroring the transfer
   `accepted` step). No auto-credit.
4. **Per-module enrollment.** The module picker on entry shows both modules; a module a facility is
   not enrolled in is **greyed out and cannot be opened** (an essential-only facility sees HIV disabled).
5. Cross-app calls (EnVo→WMS submit, WMS→EnVo status callback) authenticate with a **shared service
   token**, not a user login. Status flows back by **WMS calling an EnVo callback** on dispatch (push).

## Pattern being mirrored

EnVo's HIV resupply is `stock_transfer_log` (`backend/src/services/transferService.js`):
`pending → in_transit → accepted`, where an admin assigns a *source facility*. Essential Commodities
reuses this shape, but the counterparty is the **central warehouse** (external, the WMS), and there is
**no admin sourcing step** — submit goes straight to the warehouse.

## Relevant existing schema (EnVo, from `db/_migration/supabase_public.sql`)

- `commodities (id uuid, name, category, unit, pack_size, dispensing_unit)` — catalogue split today is
  by `category` + section membership (`backend/src/constants/sections.js`).
- `facilities (id uuid, name, code, state, lga, cluster)`
- `stock (id, facility_id, commodity_id, quantity, location_type, …)`
- `stock_transfer_log`, `dispense_log`, `intake_log`, `facility_amc_settings`, `stock_lot` — all key off
  `facility_id` + `commodity_id`, so **module is derivable from the commodity** once commodities are tagged.

## Relevant existing schema (WMS, this repo)

- `commodities`, `commodity_prices` (versioned, `is_current`), `commodity_batches`, `batch_movements`.
- `dispatch_orders` / `dispatch_order_items` — warehouse-initiated today; **no status column**, no
  requester. FEFO fill + computed total already live in `services/dispatchService.js`.
- `facilities (…, envo_facility_id)` — link back to an EnVo facility already modeled.
- `lib/envoClient.js` `fetchEnvoStock(facilityId)` — mock stub with a `// TODO` for the real EnVo call.

---

## Phase 1 — EnVo: module dimension (foundation)

**Migration** (`db/migrations/<date>_modules.sql`):
- `commodities.module text NOT NULL DEFAULT 'hiv'` — backfill all existing rows to `'hiv'`.
- `commodities.wms_commodity_id integer` (nullable; set only for essential items).
- `facility_modules (facility_id uuid REFERENCES facilities(id), module text, PRIMARY KEY (facility_id, module))`
  — enrollment join. Backfill: every existing facility → `('…','hiv')`.
- Optional reference table `modules (key text PK, label text)` seeded with `hiv`, `essential`.
- Indexes: `commodities(module)`, `facility_modules(facility_id)`.

**Backend scope** (`backend/src/middleware/scope.js` + routes): every list/read/write already filtered by
facility must also filter by the **active module**. Module arrives as a request header/param
(`x-envo-module` or `?module=`), validated against the caller's `facility_modules`. Commodity-bearing
queries join `commodities.module`; facility lists filter via `facility_modules`. Reuse the existing
section-enforcement seam so the change is one consistent place.

**Verify:** existing HIV behaviour unchanged when module defaults to `hiv`.

## Phase 2 — EnVo: module picker + scoping (frontend)

- On login, fetch the caller's enrolled modules. Render a **module picker** landing screen (both modules
  shown; non-enrolled ones greyed out + non-clickable, with a tooltip).
- Store the chosen module in app state; attach it to every API call (header/param from Phase 1).
- Existing monitoring pages (stock on hand, AMC, bincard, dispense, alerts, transfers) render unchanged
  but scoped to the active module. Add a module indicator + "switch module" affordance in the shell.

**Verify:** an HIV-only login can't open Essential; an essential-only login can't open HIV; a
both-enrolled login can switch.

## Phase 3 — EnVo: essential catalogue seeded from WMS

- **WMS master read** (this repo): expose `GET /api/catalogue/export` returning
  `{ commodities: [{ id, name, category, unit, currentPrice }] }` for the current price set (service-token auth).
- **EnVo seed script** (`backend/scripts/seedEssentialCatalogue.mjs`): pull the WMS export, upsert into
  `commodities` with `module='essential'` and `wms_commodity_id = <wms id>`, storing a synced price
  (add `commodities.unit_price numeric` or a small `commodity_prices_cache` table — price is display-only
  in EnVo; WMS remains authoritative on the order). Idempotent, matched on `wms_commodity_id`.
- Enroll the essential facility roster into `facility_modules` (`module='essential'`) via a provisioning
  script (larger/different roster than HIV — see `account-provisioning-and-login` memory).

## Phase 4 — EnVo: priced request object + outbound submit

**Migration** (`db/migrations/<date>_warehouse_requests.sql`):
- `warehouse_requests (id uuid PK, facility_id uuid, status text, total_amount numeric, wms_request_id integer,
   requested_by text, requested_at timestamptz DEFAULT now(), dispatched_at timestamptz, received_at timestamptz,
   received_by text, notes text)`. Status: `pending → submitted → picking → dispatched → received` (+ `cancelled`).
- `warehouse_request_items (id uuid PK, request_id uuid, commodity_id uuid, wms_commodity_id integer,
   qty_requested integer, unit_price numeric, line_total numeric)`.

**Service/route** (`backend/src/services/warehouseRequestService.js`, `routes/warehouseRequests.js`):
- Build request: facility picks essential commodities, sees `unit_price` + running total (from Phase 3 sync).
- Submit: write `warehouse_requests` (`pending`), then `POST` to the WMS
  `/api/requests` with `{ envoFacilityId, items:[{ wmsCommodityId, quantity }] }` (service token, with the
  existing retry pattern). Store returned `wms_request_id`, set status `submitted`.
- Receive confirmation: facility confirms → status `received`, **credit `stock`** for each line
  (reuse the transfer `accepted` credit path in `transferService._creditStock`).
- Callback endpoint `POST /api/warehouse-requests/callback` (service token): WMS reports
  `picking`/`dispatched` + authoritative totals; update the request + items.

**Frontend:** an essential-module "Request" page modeled on the transfers UI — line editor, live total,
submit, and a request list with status + a "Confirm receipt" action.

## Phase 5 — WMS: inbound request queue + pick list + fulfilment

**Migration** (`backend/migrations/016_requests.sql`, `017_request_items.sql`):
- `requests (id SERIAL PK, facility_id INTEGER REFERENCES facilities(id), envo_request_id TEXT,
   status TEXT DEFAULT 'pending', total_amount NUMERIC(14,2), received_at TIMESTAMPTZ DEFAULT now(),
   dispatch_order_id INTEGER REFERENCES dispatch_orders(id), notes TEXT)`. Status: `pending → picking → dispatched`.
- `request_items (id SERIAL PK, request_id INTEGER, commodity_id INTEGER, quantity INTEGER, unit_price NUMERIC, line_total NUMERIC)`.
- Also add `dispatch_orders.status` + `dispatch_orders.request_id` so a fulfilled request links to its dispatch.

**Service/route** (`backend/src/services/requestService.js`, `routes/requests.js`):
- `POST /api/requests` (service token): resolve `facility_id` from `envoFacilityId`, price each line from the
  current `commodity_prices`, compute the authoritative total, insert `requests` (`pending`) + items.
  Immediately call the EnVo callback with `picking` + priced totals.
- `GET /api/requests?status=pending` — warehouse queue view.
- **Pick list print**: `GET /api/requests/:id/pick-list` returns the printable document (facility, lines,
  batch/FEFO hints, total); a print-styled page in the frontend (new `RequestsPage.jsx`).
- **Fulfil**: warehouse action → call the existing `DispatchService.createOrder` (FEFO, batches, rollback),
  link `dispatch_order_id`, set `requests.status='dispatched'`, and call the EnVo callback with `dispatched`.

**Frontend:** new `RequestsPage.jsx` under Operations (queue → open → print pick list → fulfil).

## Phase 6 — WMS: real `fetchEnvoStock`

- Replace the mock in `backend/src/lib/envoClient.js` with the real call to EnVo
  `GET /facilities/:id/stock` (service token via `ENVO_API_TOKEN`, `ENVO_API_URL`), keeping the existing
  `retry()` wrapper. Confirm the EnVo endpoint returns `{ items:[{ commodityId, name, quantityOnHand, unit }] }`
  or adapt the mapping. This powers "warehouse sees EnVo facility stock on hand for essential commodities."

---

## Cross-app auth

- Shared service token in both `.env` files (`SERVICE_TOKEN`). EnVo→WMS (`/api/requests`, catalogue export)
  and WMS→EnVo (`/api/warehouse-requests/callback`, `/facilities/:id/stock`) verify it via middleware,
  distinct from user JWT auth. Rotate-able; never a user login.

## Suggested build order

Phase 1 → 2 first (everything hangs off the module dimension; ship it with HIV behaviour unchanged).
Then 3 (catalogue) → 4 + 5 together (the request round-trip) → 6 (stock visibility). Each phase is
independently testable; the request round-trip (4+5) is the one to test end-to-end against both dev servers.

## Open items to confirm before coding

- Exact EnVo `/facilities/:id/stock` response shape (Phase 6).
- Where EnVo stores the synced price (new `commodities.unit_price` vs. a cache table) — Phase 3.
- Whether a request can be partially fulfilled (transfers support partial/dispute); default here is
  all-or-nothing to match `DispatchService`.
