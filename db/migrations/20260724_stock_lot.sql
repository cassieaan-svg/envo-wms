-- Lot ledger — phase 1 (schema only; seeded by scripts/seed_stock_lots.mjs).
--
-- Per-batch stock balances, so "how many of batch X are on hand" is a stored
-- fact instead of a FEFO estimate. One row per bin + batch + expiry. A "bin" is a
-- location: the facility store, its dispensary, or a named DSD/SDP site — this
-- unifies the three existing balance tables (stock / dsd_stock / sdp_stock).
--
-- The invariant, checked by scripts/verify_stock_lots.mjs: the lots for a bin sum
-- to that bin's existing quantity. The existing balance columns stay authoritative
-- for now (nothing reads this table yet); movements will maintain lots alongside
-- them in phase 2, and phase 3 enforces (hard block, expiry block) off the lots.
--
-- batch_number / expiry_date are nullable so an "unknown" opening lot can exist
-- (the tiny gap the coverage report found); a NULL expiry never satisfies an
-- expiry check.
--
-- Apply BEFORE running the seed. Idempotent.
--   cd C:\envo\app\backend
--   node -e "import('./src/db.js').then(async ({query,pool})=>{const fs=await import('node:fs');await query(fs.readFileSync('../db/migrations/20260724_stock_lot.sql','utf8'));console.log('applied');await pool.end()})"

begin;

create table if not exists stock_lot (
  id            uuid primary key default gen_random_uuid(),
  facility_id   uuid not null references facilities(id),
  commodity_id  uuid not null references commodities(id),
  location_type text not null check (location_type in ('store','dispensary','dsd','sdp')),
  site_name     text,                       -- null for store/dispensary; the DSD/SDP site otherwise
  batch_number  text,                       -- null = unknown batch
  expiry_date   date,                       -- null = unknown expiry (never passes an expiry check)
  quantity      integer not null default 0 check (quantity >= 0),
  section       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One lot per (bin, batch, expiry). NULLs are folded to sentinels so store rows
-- (null site) and unknown batches/expiries still collide correctly under upsert.
create unique index if not exists stock_lot_bin_batch_uniq on stock_lot (
  facility_id, commodity_id, location_type,
  coalesce(site_name, ''), coalesce(batch_number, ''), coalesce(expiry_date, '0001-01-01'::date)
);

-- Read path: all lots in a bin (seed reconcile, future balance/FEFO reads).
create index if not exists stock_lot_bin_idx on stock_lot (facility_id, commodity_id, location_type, coalesce(site_name, ''));
-- Expiry sweeps (near-expiry / expired across the network).
create index if not exists stock_lot_expiry_idx on stock_lot (expiry_date) where quantity > 0;

commit;
