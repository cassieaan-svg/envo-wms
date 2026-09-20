-- Sales tracking for the Essential Commodities module: how much a facility has
-- SOLD (consumed at a per-unit price), alongside how much it has BOUGHT (already
-- tracked via warehouse_requests). A dispense snapshots the commodity's unit_price
-- at the moment it's recorded — not read live from `commodities` — so a later
-- catalogue price change never rewrites what a past sale is reported as having been
-- worth, the same reasoning warehouse_request_items already snapshots unit_price.
--
-- Nullable: a dispense of a commodity with no catalogue price (most of HIV) simply
-- carries no revenue figure, rather than a manufactured one.

begin;

alter table public.dispense_log
  add column if not exists unit_price numeric(12,2),
  add column if not exists line_total numeric(12,2);

comment on column public.dispense_log.unit_price is
  'Commodity unit_price at the moment this dispense was recorded (snapshot, not live).';
comment on column public.dispense_log.line_total is
  'quantity * unit_price at the moment this dispense was recorded (snapshot, not live).';

commit;
