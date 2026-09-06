-- Generic catalogue phase 1
--
-- `commodities` remains the canonical shared item catalogue.  This migration is
-- deliberately additive: all existing IDs, names, category assignments, module
-- assignments and stock/transaction foreign keys remain untouched.
--
-- The existing `module` column remains a legacy single-module assignment for
-- backwards compatibility.  A later phase will introduce multi-module item
-- configuration without changing these stable commodity IDs.

begin;

alter table public.commodities
  add column if not exists item_type text not null default 'commodity',
  add column if not exists item_code text,
  add column if not exists is_active boolean not null default true,
  add column if not exists description text;

-- The current catalogue is made up entirely of commodities.  This explicit
-- backfill also repairs any database restored from a partial earlier attempt.
update public.commodities
   set item_type = 'commodity'
 where item_type is null or btrim(item_type) = '';

-- Keep item type meaningful while leaving room for Tools and future item types.
alter table public.commodities
  drop constraint if exists commodities_item_type_not_blank;

alter table public.commodities
  add constraint commodities_item_type_not_blank
  check (btrim(item_type) <> '');

-- Codes are optional during the transition because the existing catalogue has
-- no canonical code for every row.  When supplied, a code identifies one item
-- regardless of case; multiple nulls remain valid.
create unique index if not exists commodities_item_code_unique
  on public.commodities (lower(item_code))
  where item_code is not null and btrim(item_code) <> '';

create index if not exists commodities_active_type_idx
  on public.commodities (is_active, item_type);

comment on column public.commodities.item_type is
  'Shared catalogue item kind (for example commodity or tool).';
comment on column public.commodities.item_code is
  'Optional canonical catalogue code, unique case-insensitively when supplied.';
comment on column public.commodities.is_active is
  'Whether the catalogue item may be selected for new operations.';
comment on column public.commodities.description is
  'Optional shared catalogue description.';

commit;
