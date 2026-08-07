-- A record of every direct repair to a stock figure.
--
-- Stock normally only moves through a recorded movement, and everything that broke
-- in this system came from something bypassing that. But a stock figure corrupted by
-- a BUG cannot be repaired by a movement: the duplicate credit was never a movement
-- in the first place, so posting an adjustment to cancel it would move the movement
-- total too, fix the stock figure and leave the opening balance exactly where it was.
--
-- The repair therefore has to touch the stock figure alone — and the price of that is
-- that it must be logged, with who did it, what the figure was, what it became, and
-- why. Without this table the repair is indistinguishable from the silent direct
-- writes that caused the problem.
--
-- Not a movement, so nothing reads it into a bin card or an opening balance. It is
-- an audit record of an engineering repair.
--
-- Run manually on prod (migrations do not auto-apply here). Idempotent.

create table if not exists stock_correction_log (
  id             uuid primary key default gen_random_uuid(),

  -- The location repaired, addressed like stock_lot.
  facility_id    uuid not null references facilities(id) on delete cascade,
  commodity_id   uuid not null references commodities(id) on delete cascade,
  location_type  text not null check (location_type in ('store','dispensary','dsd','sdp')),
  site_name      text,

  old_quantity   integer not null,
  new_quantity   integer not null,

  -- Why the figure was wrong, in words. Required: a repair with no explanation is
  -- exactly the kind of record that made the original problem untraceable.
  reason         text not null,
  corrected_by   text not null,

  -- The transfer whose double credit caused it, where that is the cause.
  transfer_id    uuid references stock_transfer_log(id) on delete set null,

  corrected_at   timestamptz not null default now()
);

create index if not exists idx_stock_correction_fac_comm on stock_correction_log (facility_id, commodity_id);
create index if not exists idx_stock_correction_at on stock_correction_log (corrected_at desc);
