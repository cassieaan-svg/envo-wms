-- Opening balances as an explicit, addressable record.
--
-- WHY. A bin card derives its opening as SOH − Σ(recorded movements): a back-solved
-- plug. Where stock existed before the records began (go-live seeding, training
-- data, records loaded without the matching stock), that plug is non-zero and the
-- card opens with a number nobody can trace or attribute.
--
-- A real bin card carries its opening as a LINE ITEM, not a silent residue. This
-- table is that line item.
--
-- Why it cannot be an adjustment. stock_adjustment_log has no location_type or
-- site_name, so adjustments only ever apply to the store; and dispensary/site bins
-- derive their movements from transfers, dispenses and returns, in which an
-- adjustment row does not participate at all. 91 of the 171 bins in the last audit
-- are dispensary or site bins — none of them could record an opening. This table
-- addresses any bin, exactly like stock_lot does.
--
-- A physical count cannot close the gap either: a count moves BOTH sides of the
-- subtraction by the same amount (raises SOH, adds a matching correction), so the
-- plug survives. Only a record explaining the pre-existing quantity closes it.
--
-- Read (and added to the movement sum) by binCardService, audit_opening_balances
-- and diagnose_bin_openings, so all three agree. It is a RECORD ONLY: the stock is
-- already on the shelf, so writing one must never credit stock again.
--
-- One row per bin: re-baselining a bin replaces its figure rather than stacking.
--
-- Run manually on prod (migrations do not auto-apply here). Idempotent.

create table if not exists bin_opening (
  id             uuid primary key default gen_random_uuid(),

  -- Addresses any bin, mirroring stock_lot. site_name is null for store/dispensary.
  facility_id    uuid not null references facilities(id) on delete cascade,
  commodity_id   uuid not null references commodities(id) on delete cascade,
  location_type  text not null check (location_type in ('store','dispensary','dsd','sdp')),
  site_name      text,

  -- The quantity the bin held before its first recorded movement. Signed: a
  -- negative opening is meaningful (stock left that nothing recorded), and
  -- refusing it would make those bins uncorrectable.
  quantity       integer not null,

  -- Dated at/just before the bin's earliest record so it reads as the first line.
  opened_at      timestamptz not null default now(),
  recorded_by    text not null,
  notes          text default '',
  created_at     timestamptz not null default now()
);

-- One opening per bin: re-baselining updates in place. Expression on site_name
-- because null never equals null in a unique constraint.
create unique index if not exists uq_bin_opening_bin
  on bin_opening (facility_id, commodity_id, location_type, coalesce(site_name,''));

-- The bin card reads this on every open, keyed the same way it filters everything.
create index if not exists idx_bin_opening_fac_comm on bin_opening (facility_id, commodity_id);
