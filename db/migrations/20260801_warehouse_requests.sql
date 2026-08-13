-- Phase 4 of Essential Commodities: the facility-raised, priced request to the central
-- warehouse (envo-wms). Mirrors the HIV transfer pattern, but the counterparty is the
-- external warehouse and there is NO envo-admin approval step. Lifecycle:
--   pending    - written locally, not yet accepted by the WMS
--   submitted  - the WMS acknowledged it (has a wms_request_id)
--   picking    - warehouse is picking (WMS callback)
--   dispatched - warehouse dispatched (WMS callback)
--   received   - facility confirmed receipt; stock credited
--   cancelled  - withdrawn before dispatch
--
-- Apply:  psql "$DATABASE_URL" -f db/migrations/20260801_warehouse_requests.sql
-- Idempotent.

create table if not exists warehouse_requests (
  id            uuid primary key default gen_random_uuid(),
  facility_id   uuid not null references facilities(id),
  status        text not null default 'pending',
  total_amount  numeric(14,2) not null default 0,
  wms_request_id integer,                 -- the WMS-side request id, null until submitted
  requested_by  text,
  requested_at  timestamptz not null default now(),
  submitted_at  timestamptz,
  dispatched_at timestamptz,
  received_at   timestamptz,
  received_by   text,
  notes         text
);
create index if not exists warehouse_requests_facility_idx on warehouse_requests (facility_id, requested_at desc);
create index if not exists warehouse_requests_wms_idx on warehouse_requests (wms_request_id);

create table if not exists warehouse_request_items (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references warehouse_requests(id) on delete cascade,
  commodity_id   uuid not null references commodities(id),
  wms_commodity_id integer,               -- denormalised for the outbound POST to the WMS
  qty_requested  integer not null check (qty_requested > 0),
  qty_dispatched integer,                 -- set from the WMS dispatch callback (FEFO may short a line)
  unit_price     numeric(12,2),           -- price snapshot at request time
  line_total     numeric(14,2)
);
create index if not exists warehouse_request_items_request_idx on warehouse_request_items (request_id);
