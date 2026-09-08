-- Generic catalogue phase 2: configurable categories and module membership.
--
-- The legacy commodities.module/category columns are intentionally retained for
-- current HIV and Essential code.  The new tables are the forward-compatible
-- representation: a catalogue item may be enabled in several modules and may
-- have a different category/configuration in each module.

begin;

create table if not exists public.commodity_categories (
  id          uuid primary key default gen_random_uuid(),
  module      text not null references public.modules(key) on delete restrict,
  name        text not null,
  code        text,
  parent_id   uuid references public.commodity_categories(id) on delete restrict,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint commodity_categories_name_not_blank check (btrim(name) <> ''),
  constraint commodity_categories_code_not_blank check (code is null or btrim(code) <> '')
);

-- A category is unique within a module, case-insensitively.  The composite key
-- below lets commodity_modules prove that its category belongs to its module.
create unique index if not exists commodity_categories_module_name_unique
  on public.commodity_categories (module, lower(name));
create unique index if not exists commodity_categories_id_module_unique
  on public.commodity_categories (id, module);
create unique index if not exists commodity_categories_module_code_unique
  on public.commodity_categories (module, lower(code))
  where code is not null;

create table if not exists public.commodity_modules (
  commodity_id  uuid not null references public.commodities(id) on delete restrict,
  module        text not null references public.modules(key) on delete restrict,
  category_id   uuid,
  is_active     boolean not null default true,
  module_sku    text,
  configuration jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (commodity_id, module),
  constraint commodity_modules_configuration_object
    check (jsonb_typeof(configuration) = 'object'),
  constraint commodity_modules_category_module_fkey
    foreign key (category_id, module)
    references public.commodity_categories(id, module)
    on delete restrict
);

create index if not exists commodity_modules_module_category_idx
  on public.commodity_modules (module, category_id)
  where is_active;
create unique index if not exists commodity_modules_module_sku_unique
  on public.commodity_modules (module, lower(module_sku))
  where module_sku is not null and btrim(module_sku) <> '';

-- Preserve every legacy category verbatim under its current module.
insert into public.commodity_categories (module, name)
select distinct c.module, btrim(c.category)
  from public.commodities c
 where c.category is not null and btrim(c.category) <> ''
on conflict do nothing;

-- One legacy module assignment becomes one active membership.  The membership
-- carries the category because categories are module-specific.
insert into public.commodity_modules (commodity_id, module, category_id, is_active)
select c.id, c.module, cc.id, c.is_active
  from public.commodities c
  join public.commodity_categories cc
    on cc.module = c.module
   and lower(cc.name) = lower(btrim(c.category))
on conflict (commodity_id, module) do update
  set category_id = excluded.category_id,
      is_active = excluded.is_active,
      updated_at = now();

do $$
declare
  missing_memberships integer;
  missing_categories integer;
begin
  select count(*) into missing_memberships
    from public.commodities c
   where not exists (
     select 1 from public.commodity_modules cm
      where cm.commodity_id = c.id and cm.module = c.module
   );
  if missing_memberships > 0 then
    raise exception 'Generic catalogue migration left % commodities without their legacy module membership', missing_memberships;
  end if;

  select count(*) into missing_categories
    from public.commodities c
    left join public.commodity_modules cm
      on cm.commodity_id = c.id and cm.module = c.module
   where c.category is not null and btrim(c.category) <> '' and cm.category_id is null;
  if missing_categories > 0 then
    raise exception 'Generic catalogue migration left % commodities without their legacy category', missing_categories;
  end if;
end $$;

comment on table public.commodity_categories is
  'Configurable category hierarchy scoped to a catalogue module.';
comment on table public.commodity_modules is
  'A catalogue item enabled in a module, with module-specific category, SKU and configuration.';

commit;
