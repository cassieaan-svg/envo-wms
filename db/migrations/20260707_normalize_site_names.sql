-- Normalize DSD/SDP site-name casing so a site's own login sees its stock.
--
-- Root cause: dsd_stock.dsd_site_name / sdp_stock.sdp_name are the join key
-- between the store's dispatched stock and the DSD/SDP account, but the value
-- drifted in case/whitespace (e.g. "Vinzorb Pharmacy" in the stock rows vs
-- "VINZORB Pharmacy" on the account). The backend matched exactly, so the
-- account's Stock page returned nothing though the stock existed.
--
-- The backend now matches site names case-insensitively (reads + writes), so
-- this migration is a one-off tidy-up: collapse any duplicate-cased rows and
-- rename the survivors to each account's canonical name so the store's per-site
-- breakdown shows a single, consistent entry. Idempotent and safe to re-run.

begin;

-- ── DSD ───────────────────────────────────────────────────────────────────────
-- 1) Merge rows that differ only by case/whitespace for the same facility +
--    commodity: sum their quantities into the lowest-id row, delete the rest.
with agg as (
  select facility_id, commodity_id, lower(btrim(dsd_site_name)) as k,
         min(id::text) as keep_id, sum(quantity) as total
  from dsd_stock
  group by facility_id, commodity_id, lower(btrim(dsd_site_name))
  having count(*) > 1
)
update dsd_stock d set quantity = agg.total, updated_at = now()
from agg where d.id::text = agg.keep_id;

with agg as (
  select facility_id, commodity_id, lower(btrim(dsd_site_name)) as k, min(id::text) as keep_id
  from dsd_stock
  group by facility_id, commodity_id, lower(btrim(dsd_site_name))
  having count(*) > 1
)
delete from dsd_stock d using agg
where d.facility_id = agg.facility_id
  and d.commodity_id = agg.commodity_id
  and lower(btrim(d.dsd_site_name)) = agg.k
  and d.id::text <> agg.keep_id;

-- 2) Rename surviving rows to the account's exact casing (one canonical name per
--    facility + site, picked deterministically when accounts themselves disagree).
update dsd_stock d
set dsd_site_name = canon.site, updated_at = now()
from (
  select distinct on (raw_user_meta_data->>'facility_id', lower(btrim(raw_user_meta_data->>'dsd_site_name')))
         raw_user_meta_data->>'facility_id' as facility_id,
         raw_user_meta_data->>'dsd_site_name' as site
  from users
  where raw_user_meta_data->>'facility_role' = 'dsd'
    and coalesce(raw_user_meta_data->>'dsd_site_name', '') <> ''
    and coalesce(raw_user_meta_data->>'facility_id', '') <> ''
  order by raw_user_meta_data->>'facility_id',
           lower(btrim(raw_user_meta_data->>'dsd_site_name')),
           raw_user_meta_data->>'dsd_site_name'
) canon
where d.facility_id::text = canon.facility_id
  and lower(btrim(d.dsd_site_name)) = lower(btrim(canon.site))
  and d.dsd_site_name <> canon.site;

-- ── SDP ───────────────────────────────────────────────────────────────────────
with agg as (
  select facility_id, commodity_id, lower(btrim(sdp_name)) as k,
         min(id::text) as keep_id, sum(quantity) as total
  from sdp_stock
  group by facility_id, commodity_id, lower(btrim(sdp_name))
  having count(*) > 1
)
update sdp_stock s set quantity = agg.total, updated_at = now()
from agg where s.id::text = agg.keep_id;

with agg as (
  select facility_id, commodity_id, lower(btrim(sdp_name)) as k, min(id::text) as keep_id
  from sdp_stock
  group by facility_id, commodity_id, lower(btrim(sdp_name))
  having count(*) > 1
)
delete from sdp_stock s using agg
where s.facility_id = agg.facility_id
  and s.commodity_id = agg.commodity_id
  and lower(btrim(s.sdp_name)) = agg.k
  and s.id::text <> agg.keep_id;

update sdp_stock s
set sdp_name = canon.site, updated_at = now()
from (
  select distinct on (raw_user_meta_data->>'facility_id', lower(btrim(raw_user_meta_data->>'sdp_name')))
         raw_user_meta_data->>'facility_id' as facility_id,
         raw_user_meta_data->>'sdp_name' as site
  from users
  where raw_user_meta_data->>'facility_role' = 'sdp'
    and coalesce(raw_user_meta_data->>'sdp_name', '') <> ''
    and coalesce(raw_user_meta_data->>'facility_id', '') <> ''
  order by raw_user_meta_data->>'facility_id',
           lower(btrim(raw_user_meta_data->>'sdp_name')),
           raw_user_meta_data->>'sdp_name'
) canon
where s.facility_id::text = canon.facility_id
  and lower(btrim(s.sdp_name)) = lower(btrim(canon.site))
  and s.sdp_name <> canon.site;

-- ── Report any site stock that still has no matching account (orphan stock from
--    a free-text dispatch before the registered-sites dropdown existed). Not
--    fatal — just surfaces sites a login can still never see until an account is
--    created for them.
do $$
declare orphan_dsd int; orphan_sdp int;
begin
  select count(*) into orphan_dsd from dsd_stock d
   where not exists (
     select 1 from users u
      where u.raw_user_meta_data->>'facility_role' = 'dsd'
        and u.raw_user_meta_data->>'facility_id' = d.facility_id::text
        and lower(btrim(u.raw_user_meta_data->>'dsd_site_name')) = lower(btrim(d.dsd_site_name)));
  select count(*) into orphan_sdp from sdp_stock s
   where not exists (
     select 1 from users u
      where u.raw_user_meta_data->>'facility_role' = 'sdp'
        and u.raw_user_meta_data->>'facility_id' = s.facility_id::text
        and lower(btrim(u.raw_user_meta_data->>'sdp_name')) = lower(btrim(s.sdp_name)));
  raise notice 'Site-name normalization done. Orphan rows with no matching account — DSD: %, SDP: %', orphan_dsd, orphan_sdp;
end $$;

commit;
