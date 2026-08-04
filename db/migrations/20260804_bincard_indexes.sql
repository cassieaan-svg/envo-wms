-- Bin-card / diagnostic / audit read-path indexes. Every bin card filters each log
-- table by (facility_id, commodity_id); only single-column indexes existed, so
-- Postgres could use one and filter the rest. Add the composite so a bin card is a
-- tight index range scan instead of a scan-and-filter. stock_transfer_log had NO
-- commodity_id index at all, yet the bin card filters transfers by it.
--
-- All IF NOT EXISTS = idempotent. Plain (non-CONCURRENT) builds briefly lock writes
-- while building — fast at current volumes, but run during low traffic. Run manually
-- on prod (migrations don't auto-apply here).

create index if not exists idx_intake_fac_comm            on intake_log            (facility_id, commodity_id);
create index if not exists idx_dispense_fac_comm          on dispense_log          (facility_id, commodity_id);
create index if not exists idx_adjustment_fac_comm        on stock_adjustment_log  (facility_id, commodity_id);
create index if not exists idx_transfer_commodity         on stock_transfer_log    (commodity_id);
