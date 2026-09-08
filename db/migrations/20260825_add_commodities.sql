-- Add three commodities to the HIV catalogue (2026-08-25).
--
--   Cryovials (White)                    -> Lab consumables
--   Izal (1 Litre)                       -> Lab consumables
--   TDF/3TC/EFV 300/300/400mg (90 tabs)  -> Pharmacy drugs
--
-- Column values follow the nearest existing siblings rather than being invented:
--   * Cryovials (White) mirrors Cryovials (Red)/(Blue) - unit 'piece', no pack_size.
--   * TDF/3TC/EFV mirrors the other TDF/3TC regimens - unit 'bottles',
--     dispensing_unit 'tablet', pack_size '90 tablets', tablet count in the name
--     (main's later 20260825_tdf_3tc_efv_pack_size.sql fix is folded in directly
--     here, so that migration is a no-op on a database that runs this one first).
--   * Izal (1 Litre) is a NEW row, not a rename. An 'Izal' already exists but it
--     belongs to the ESSENTIAL module (4L, priced) - a different catalogue, so
--     the two do not collide.
--
-- Names the module explicitly (this branch has commodities.module, unlike main at
-- the time this was written) and guards on (name, module) rather than name alone,
-- so re-running is safe even before commodities_name_unique exists.
insert into commodities (name, category, unit, pack_size, dispensing_unit, module)
select v.name, v.category, v.unit, v.pack_size, v.dispensing_unit, v.module
from (values
  ('Cryovials (White)',                   'Lab consumables', 'piece',   null,         null,     'hiv'),
  ('Izal (1 Litre)',                      'Lab consumables', 'bottles', null,         'bottle', 'hiv'),
  ('TDF/3TC/EFV 300/300/400mg (90 tabs)', 'Pharmacy drugs',  'bottles', '90 tablets', 'tablet', 'hiv')
) as v(name, category, unit, pack_size, dispensing_unit, module)
where not exists (
  select 1 from commodities c where c.name = v.name and c.module = v.module
);
