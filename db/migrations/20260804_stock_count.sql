-- Stock counts as a first-class record.
--
-- WHY. A physical count is a real-world event: someone stood at a shelf on a date
-- and counted. Today that fact is thrown away — only its consequence survives, as a
-- 'Physical count correction' row in stock_adjustment_log holding a DELTA. Two
-- things follow from that, and both are in production now:
--
--   1. Delta/target confusion. Staff count the shelf and type the COUNT (200,
--      meaning "there are 200"). The system reads a DELTA ("remove 200 more").
--      Repeat at three stock-takes and you get Apapa General Hospital's
--      -1766 / -1746 / -1723 — not three losses, one shelf counted three times.
--      Recorded outflows then exceed inflows, and the bin card back-solves the
--      contradiction into a phantom +3,758 opening balance.
--   2. Counts and losses are indistinguishable. 'Expired'/'Damaged'/'Lost' are real
--      stock leaving. A count is a correction of the books. Mixed in one table, no
--      audit can separate "we lost stock" from "our records were wrong".
--
-- THE FIX. Store the fact (counted_quantity), derive the consequence. A count is
-- then IDEMPOTENT: counting 200 twice yields variance 0 the second time, so the
-- Apapa failure mode becomes impossible by construction.
--
-- A count is also the ONE operation permitted to set stock directly, because it is
-- backed by physical observation — everywhere else, stock may only move via a
-- recorded movement. The derived adjustment still goes to stock_adjustment_log
-- (linked via adjustment_id) so the ledger stays the single source of movements and
-- the bin card needs no special case.
--
-- Client returns ('Returned to store') are deliberately OUT of scope: that is stock
-- physically re-entering from a client, a genuine inflow, already correct as an
-- Increase adjustment. This table is only about reconciling books to shelf.
--
-- Run manually on prod (migrations do not auto-apply here).

create table if not exists stock_count (
  id                uuid primary key default gen_random_uuid(),

  -- WHICH BIN. Mirrors stock_lot's addressing so a count can target any bin, not
  -- just the store (dispensary and SDP/DSD bins drift too — see the audit).
  -- site_name is null for store/dispensary, the site for dsd/sdp.
  facility_id       uuid not null references facilities(id) on delete cascade,
  commodity_id      uuid not null references commodities(id) on delete cascade,
  location_type     text not null check (location_type in ('store','dispensary','dsd','sdp')),
  site_name         text,

  -- THE FACT: what was physically on the shelf. This is the value staff enter, and
  -- the reason this table exists. Never a delta. >= 0: you cannot count negative.
  counted_quantity  integer not null check (counted_quantity >= 0),

  -- THE BOOKS: what the system believed at the moment of the count. Captured
  -- server-side, never client-supplied, so variance cannot be gamed or mis-typed.
  system_quantity   integer not null,

  -- Derived, never written. Positive = more on shelf than books (books under-counted);
  -- negative = shortfall. Stored so it can be indexed and reported on directly.
  variance          integer generated always as (counted_quantity - system_quantity) stored,

  -- Whole-bin counts only (by design): staff count tins on a shelf, not batches.
  -- The lot ledger is reconciled to the counted total FEFO — excess trimmed
  -- soonest-expiry-first, shortfall topped up as an unknown-expiry lot. Trade-off:
  -- a count tells you the bin was short, not WHICH batch was short.

  -- The adjustment this count generated, so the movement ledger and the count are
  -- provably the same event. Null when variance = 0 (nothing to post) or if the
  -- adjustment was later deleted.
  adjustment_id     uuid references stock_adjustment_log(id) on delete set null,

  -- WHO / WHEN / WHY. counted_at is the date of the physical count, which may
  -- precede entry; created_at is when it was keyed in. Keeping both means a
  -- back-dated count is still auditable as such.
  counted_by        text not null,
  counted_at        timestamptz not null default now(),
  notes             text default '',
  section           text,
  created_at        timestamptz not null default now()
);

-- The derived adjustment carries reason 'Stock count variance', which the existing
-- allow-list constraint on stock_adjustment_log.reason does not permit — so counts
-- would fail at the last step without this. Rebuilt rather than extended because a
-- CHECK cannot be altered in place. 'Physical count correction' is RETIRED from the
-- UI but kept here: thousands of historical rows carry it and would fail validation.
-- NOT VALID preserves the original's semantics (enforced on new rows, existing rows
-- not re-checked), which matters given the historical data this table holds.
alter table stock_adjustment_log drop constraint if exists stock_adjustment_log_reason_check;
alter table stock_adjustment_log add constraint stock_adjustment_log_reason_check
  check (reason = any (array[
    'Expired', 'Damaged', 'Lost / Stolen',
    'Stock count variance',        -- derived from a physical count (new)
    'Physical count correction',   -- retired predecessor; historical rows only
    'Returned to store', 'Returned from Dispensary', 'Returned from DSD',
    'Returned from SDP', 'State Office', 'Other'
  ])) not valid;

-- Reporting/read paths filter by bin, exactly like the bin card does.
create index if not exists idx_stock_count_fac_comm on stock_count (facility_id, commodity_id);
create index if not exists idx_stock_count_counted_at on stock_count (counted_at desc);
-- "Show me where the books and the shelf disagree" — the whole point of the table.
create index if not exists idx_stock_count_variance on stock_count (facility_id, variance) where variance <> 0;

-- Guard against the double-submit that a slow save + impatient click produces:
-- the same bin counted at the same instant is one event, not two. Uses an
-- expression on site_name because null never equals null in a unique constraint.
create unique index if not exists uq_stock_count_bin_instant
  on stock_count (facility_id, commodity_id, location_type, coalesce(site_name,''), counted_at);
