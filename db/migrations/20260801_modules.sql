-- Phase 1 of the Essential Commodities work: introduce a `module` dimension so the
-- app can host more than one commodity programme (HIV today; Essential Commodities
-- next) in the same database. Full design: sibling envo-wms repo
-- docs/ESSENTIAL_COMMODITIES_PLAN.md.
--
-- What this adds:
--   * modules              reference table — the allowed module keys
--   * commodities.module   every commodity belongs to exactly one module
--   * commodities.wms_commodity_id   link to the WMS catalogue (essential items only)
--   * facility_modules     which modules a facility is enrolled in (many-to-many)
--
-- All existing data is HIV: every current commodity and facility is backfilled to
-- 'hiv', so behaviour is unchanged until essential data is loaded. Module is derivable
-- for stock / dispense / intake / transfer rows via their commodity, so no other table
-- needs a column.
--
-- Apply:  psql "$DATABASE_URL" -f db/migrations/20260801_modules.sql
-- Idempotent: safe to re-run.

begin;

-- Allowed modules. Source of truth; the columns below FK to it, so adding a module
-- later is one insert here rather than editing a CHECK constraint.
create table if not exists modules (
  key   text primary key,
  label text not null
);

insert into modules (key, label) values
  ('hiv',       'HIV Commodities'),
  ('essential', 'Essential Commodities')
on conflict (key) do nothing;

-- Every commodity belongs to one module. DEFAULT 'hiv' backfills all existing rows in
-- place; the FK is satisfied because 'hiv' was inserted above in this same transaction.
alter table commodities
  add column if not exists module text not null default 'hiv' references modules(key),
  add column if not exists wms_commodity_id integer;

-- Facility <-> module enrollment. A facility may belong to more than one module; the
-- app's module picker greys out (and blocks) any module a facility is NOT enrolled in.
create table if not exists facility_modules (
  facility_id uuid  not null references facilities(id) on delete cascade,
  module      text  not null references modules(key),
  primary key (facility_id, module)
);

-- Backfill: every existing facility is an HIV facility.
insert into facility_modules (facility_id, module)
select id, 'hiv' from facilities
on conflict do nothing;

create index if not exists commodities_module_idx on commodities (module);
create index if not exists facility_modules_facility_idx on facility_modules (facility_id);

-- wms_commodity_id is the WMS catalogue key: unique when set (one WMS item maps to one
-- EnVo commodity), but null for every HIV item — hence a partial unique index.
create unique index if not exists commodities_wms_commodity_id_key
  on commodities (wms_commodity_id) where wms_commodity_id is not null;

-- Fail loudly if the backfill left anything unassigned.
do $$
declare n int;
begin
  select count(*) into n from commodities where module is null;
  if n > 0 then raise exception 'commodities.module still NULL for % row(s)', n; end if;

  select count(*) into n from facilities f
   where not exists (select 1 from facility_modules fm where fm.facility_id = f.id);
  if n > 0 then raise exception '% facilit(ies) have no module enrollment', n; end if;
end $$;

commit;
