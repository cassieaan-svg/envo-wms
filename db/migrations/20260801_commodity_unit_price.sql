-- Essential-commodity display price, synced from the WMS (the catalogue/price master,
-- see docs in the sibling envo-wms repo). Nullable: HIV commodities have no price here,
-- and unpriced essential items (the 11 inactive ones) stay null. The WMS stays
-- authoritative — this is only what EnVo shows while a facility builds a request; the
-- WMS recomputes the real total on the pick order.
--
-- Apply:  psql "$DATABASE_URL" -f db/migrations/20260801_commodity_unit_price.sql
-- Idempotent.

alter table commodities add column if not exists unit_price numeric(12,2);
