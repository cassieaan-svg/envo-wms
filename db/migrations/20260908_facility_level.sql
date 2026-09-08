-- Facility level (PHC vs Secondary), for the Essential Commodities facility
-- roster sourced from Akwa Ibom's official facility lists. Nullable and free of
-- any constraint against existing rows, since only the Essential intake sets it
-- for now — HIV facilities are untouched.
--
-- Intended use: an LGA admin oversees both levels for their LGA together, with a
-- level filter in the UI to narrow the view — not two separate admin roles.

alter table public.facilities
  add column if not exists level text;

alter table public.facilities
  drop constraint if exists facilities_level_check;

alter table public.facilities
  add constraint facilities_level_check
  check (level is null or level in ('phc', 'secondary'));

comment on column public.facilities.level is
  'Facility level for Essential Commodities: phc or secondary. Null for facilities not yet classified (all pre-existing HIV-only facilities).';
