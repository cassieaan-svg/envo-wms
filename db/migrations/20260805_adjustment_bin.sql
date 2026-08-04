-- Adjustments become bin-addressable, and the stock_count experiment is removed.
--
-- WHY BIN-ADDRESSABLE. stock_adjustment_log had no location_type or site_name, so
-- every adjustment implicitly hit the STORE. A store manager who counted the
-- dispensary or an SDP shelf had nowhere to record the correction, and any
-- correction they did enter silently moved the store instead — so the bin card for
-- the bin they actually counted never changed, while the store's drifted. 91 of the
-- 171 bins in the last audit are dispensary or site bins.
--
-- Now an adjustment says which bin it corrects, and the bin card, audit and
-- diagnostics all attribute it there. Existing rows default to 'store', which is
-- exactly what they were.
--
-- WHY stock_count GOES. It was a second way to write the same fact. If a variance
-- has to be explained — and it does, or careless stock quietly becomes an approved
-- correction — then the record IS an adjustment, and two mechanisms for one fact is
-- worse than one. 'Physical count correction' returns as a plain delta, with notes
-- compulsory so every correction carries a written reason and a name.
--
-- The table is dropped rather than left dormant: it was never deployed, so it holds
-- no data, and a dead table invites someone to wire it back up.
--
-- Run manually on prod (migrations do not auto-apply here). Idempotent.

alter table stock_adjustment_log add column if not exists location_type text;
alter table stock_adjustment_log add column if not exists site_name text;

-- Everything written before this migration adjusted the store, by construction.
update stock_adjustment_log set location_type = 'store' where location_type is null;

alter table stock_adjustment_log alter column location_type set default 'store';
do $$ begin
  alter table stock_adjustment_log add constraint stock_adjustment_log_location_check
    check (location_type in ('store','dispensary','dsd','sdp'));
exception when duplicate_object then null; end $$;

-- The bin card filters adjustments per bin on every open.
create index if not exists idx_adjustment_fac_comm_loc
  on stock_adjustment_log (facility_id, commodity_id, location_type);

-- Drop the retired reason from the allow-list. 'Physical count correction' stays:
-- it is the supported reason again, and thousands of historical rows carry it.
alter table stock_adjustment_log drop constraint if exists stock_adjustment_log_reason_check;
alter table stock_adjustment_log add constraint stock_adjustment_log_reason_check
  check (reason = any (array[
    'Expired', 'Damaged', 'Lost / Stolen',
    'Physical count correction',
    'Opening balance',             -- recorded baseline (bin_opening's ledger twin)
    'Returned to store', 'Returned from Dispensary', 'Returned from DSD',
    'Returned from SDP', 'State Office', 'Other'
  ])) not valid;

drop table if exists stock_count;
