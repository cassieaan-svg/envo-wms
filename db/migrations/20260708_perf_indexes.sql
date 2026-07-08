-- Performance indexes for admin aggregate queries (stock / AMC / expiry rollups
-- across many facilities). The covering (INCLUDE) indexes let the AMC and expiry
-- sums run as index-only scans — no heap fetch — which is the hot path when an
-- admin opens a dashboard over a whole state.
--
-- IF NOT EXISTS = idempotent. NOTE: a plain (non-CONCURRENT) build briefly locks
-- writes on the table while it builds; fast at current volumes, but run during
-- low traffic to be safe. Run manually on prod.

-- Consumption / AMC: sum(quantity) by commodity over a facility set + date window.
create index if not exists idx_dispense_fac_date_incl
  on dispense_log (facility_id, dispensed_at) include (commodity_id, quantity);

-- Expiry rollups (batches expiring in a window) and received-over-range.
create index if not exists idx_intake_fac_expiry_incl
  on intake_log (facility_id, expiry_date) include (commodity_id, quantity);
create index if not exists idx_intake_fac_received
  on intake_log (facility_id, received_at);

-- Adjustment rollups (CRRF / reports) by facility + date.
create index if not exists idx_adj_fac_date
  on stock_adjustment_log (facility_id, adjusted_at);
