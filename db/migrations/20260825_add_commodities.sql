-- Add three commodities to the HIV catalogue (2026-08-25).
--
--   Cryovials (White)            → Lab consumables
--   Izal (1 Litre)               → Lab consumables
--   TDF/3TC/EFV 300/300/400mg    → Pharmacy drugs
--
-- Column values follow the nearest existing siblings rather than being invented:
--   * Cryovials (White) mirrors Cryovials (Red)/(Blue) exactly — unit 'piece',
--     no pack_size, no dispensing_unit.
--   * TDF/3TC/EFV mirrors the other TDF/3TC regimens — unit 'bottles',
--     dispensing_unit 'tablet'. pack_size is left NULL because the request did
--     not state a tablet count, and the sibling rows carry one ('90 tablets');
--     set it once the pack is confirmed rather than guessing.
--   * Izal (1 Litre) is a NEW row, not a rename. An 'Izal' already exists but it
--     belongs to the ESSENTIAL module (4L, priced) — a different catalogue, so
--     the two do not collide.
--
-- Idempotent: re-running inserts nothing. Names are the natural key here; the
-- table has no unique constraint on name, so a plain INSERT would duplicate on a
-- second run and split a commodity's stock across two ids.
insert into commodities (name, category, unit, pack_size, dispensing_unit, module)
select v.name, v.category, v.unit, v.pack_size, v.dispensing_unit, v.module
from (values
  ('Cryovials (White)',         'Lab consumables', 'piece',   null,     null,     'hiv'),
  ('Izal (1 Litre)',            'Lab consumables', 'bottles', null,     'bottle', 'hiv'),
  ('TDF/3TC/EFV 300/300/400mg', 'Pharmacy drugs',  'bottles', null,     'tablet', 'hiv')
) as v(name, category, unit, pack_size, dispensing_unit, module)
where not exists (
  select 1 from commodities c where c.name = v.name and c.module = v.module
);
