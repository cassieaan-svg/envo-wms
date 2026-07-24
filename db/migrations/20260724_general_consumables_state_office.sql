-- New "General Consumables" commodity category, handled only by the per-state
-- "State Office Store" facilities. The category is deliberately NOT part of the
-- pharmacy or lab section lists, so regular section-pinned facilities never see it;
-- the app appends it to a state-office caller's include-list (see
-- backend/src/constants/sections.js STATE_OFFICE_CATEGORIES and attachScope), and
-- null-section admins see it as part of the full catalogue.
--
-- pack_size is unknown for these items (left null). Units: Hypo Bleach is issued in
-- bottles; the rest in pieces. Idempotent — inserts each item only if a commodity of
-- that name does not already exist, so it is safe to re-run.

begin;

insert into commodities (name, category, unit, pack_size, dispensing_unit)
select v.name, 'General Consumables', v.unit, null, v.dispensing_unit
from (values
  ('Mucus extractor',    'pieces',  'piece'),
  ('BP Apparatus',       'pieces',  'piece'),
  ('Hypo Bleach',        'bottles', 'bottle'),
  ('Dolphin Needle 21g', 'pieces',  'piece'),
  ('Dolphin Needle 23g', 'pieces',  'piece'),
  ('Car Cooler',         'pieces',  'piece'),
  ('Household Cooler',   'pieces',  'piece'),
  ('Lancet',             'pieces',  'piece')
) as v(name, unit, dispensing_unit)
where not exists (
  select 1 from commodities c where c.name = v.name
);

commit;
