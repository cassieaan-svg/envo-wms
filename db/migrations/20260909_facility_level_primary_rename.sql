-- Rename the 'phc' facility level to 'primary' (PHC vs Secondary read as
-- "primary vs secondary" health care, matching how the state names the tiers).
-- The constraint is widened to allow both spellings first, so the rename UPDATE
-- below isn't rejected mid-flight, then tightened back down to just the new pair.

alter table public.facilities
  drop constraint if exists facilities_level_check;

alter table public.facilities
  add constraint facilities_level_check
  check (level is null or level in ('phc', 'primary', 'secondary'));

update public.facilities set level = 'primary' where level = 'phc';

update public.user_role_scopes set scope_id = 'primary'
 where dimension = 'facility_level' and scope_id = 'phc';

update public.users
   set raw_user_meta_data = jsonb_set(raw_user_meta_data, '{admin_level}', '"primary"')
 where raw_user_meta_data->>'admin_level' = 'phc';

alter table public.facilities
  drop constraint if exists facilities_level_check;

alter table public.facilities
  add constraint facilities_level_check
  check (level is null or level in ('primary', 'secondary'));

comment on column public.facilities.level is
  'Facility level for Essential Commodities: primary or secondary. Null for facilities not yet classified (all pre-existing HIV-only facilities).';
