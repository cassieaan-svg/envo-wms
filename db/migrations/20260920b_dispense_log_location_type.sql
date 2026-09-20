-- dispense_log has never carried its own bin: the site (DSD/SDP) is inferred from a
-- notes tag, and an untagged dispense has always been assumed to belong to the
-- dispensary. That assumption breaks the moment Essential Commodities starts
-- debiting store directly for consumption instead — there would be no way to tell
-- an old dispensary-sourced dispense apart from a new store-sourced one for
-- editing/deleting it or reconstructing the bin card.
--
-- Backfilling every existing row to 'dispensary' is correct as written: Essential
-- Commodities has never recorded a store-only dispense before this migration (it
-- has no production usage yet), so every row that exists today really was a
-- dispensary dispense (HIV) or is one of the handful of dev/test essential rows,
-- which this migration deliberately does not try to distinguish — there's nothing
-- to reconcile.

begin;

alter table public.dispense_log
  add column if not exists location_type varchar default 'dispensary';

update public.dispense_log set location_type = 'dispensary' where location_type is null;

comment on column public.dispense_log.location_type is
  'The bin this dispense debited (store or dispensary) when not a DSD/SDP site dispense (those stay tagged in notes). Backfilled to dispensary for rows written before this column existed.';

commit;
