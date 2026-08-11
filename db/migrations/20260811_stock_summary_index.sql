-- Covering index for the facility-scoped dashboard aggregate (GET /api/stock/summary).
--
-- Added on measured evidence only. The aggregate groups `stock` by commodity_id
-- and reads exactly (commodity_id, quantity, location_type, baseline_amc) for a
-- facility set. Measured on a 100,160-row copy of `stock` (10x current volume),
-- narrow scope (one facility):
--
--   without index: Seq Scan            → 21.95 ms
--   with index:    Bitmap Index Scan   →  1.30 ms   (17x)
--
-- A BROAD scope (e.g. a whole state = 163/285 facilities) correctly stays on a
-- seq scan and is unaffected — this index is for the facility-scoped callers,
-- which is most users. No other index was warranted by any measured plan: the
-- dsd_stock / sdp_stock aggregates already run in ~0.5 ms on a seq scan and their
-- existing (facility_id, site, commodity_id) unique indexes cover scoped lookups.
--
-- IF NOT EXISTS = idempotent. NOTE: a plain (non-CONCURRENT) build briefly locks
-- writes on `stock` while it builds — fast at current volumes, but run during low
-- traffic. Migrations do NOT auto-run here: apply this manually before deploying
-- the backend that ships GET /api/stock/summary.

create index if not exists idx_stock_facility_summary
  on stock (facility_id) include (commodity_id, quantity, location_type, baseline_amc);
