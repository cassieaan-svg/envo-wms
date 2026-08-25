-- Add three commodities to the HIV catalogue (2026-08-25).
--
--   Cryovials (White)                    -> Lab consumables
--   Izal (1 Litre)                       -> Lab consumables
--   TDF/3TC/EFV 300/300/400mg (90 tabs)  -> Pharmacy drugs
--
-- Column values follow the nearest existing siblings rather than being invented:
--   * Cryovials (White) mirrors Cryovials (Red)/(Blue) - unit 'piece', no pack_size.
--   * TDF/3TC/EFV mirrors the other TDF/3TC regimens - unit 'bottles',
--     dispensing_unit 'tablet', pack_size '90 tablets', tablet count in the name.
--   * Izal (1 Litre) is a NEW row, not a rename. An 'Izal' already exists in the
--     Essential catalogue (4L, priced) - a different product at a different size.
--
-- DELIBERATELY DOES NOT MENTION commodities.module. That column is added by
-- 20260801_modules.sql, which belongs to the Essential Commodities work and is not
-- on main - so it does not exist on production, and naming it here aborted the
-- whole batch with "column module of relation commodities does not exist". Where
-- the column does exist its default ('hiv') gives these rows the right value
-- anyway, so omitting it is correct on both shapes of database.
--
-- Idempotent: `commodities_name_unique` makes the name the natural key, so the
-- guard needs nothing else, and the insert writes the FINAL name - re-running
-- after any later rename cannot resurrect an older one.
insert into commodities (name, category, unit, pack_size, dispensing_unit)
select v.name, v.category, v.unit, v.pack_size, v.dispensing_unit
from (values
  ('Cryovials (White)',                   'Lab consumables', 'piece',   null,         null),
  ('Izal (1 Litre)',                      'Lab consumables', 'bottles', null,         'bottle'),
  ('TDF/3TC/EFV 300/300/400mg (90 tabs)', 'Pharmacy drugs',  'bottles', '90 tablets', 'tablet')
) as v(name, category, unit, pack_size, dispensing_unit)
where not exists (select 1 from commodities c where c.name = v.name)
on conflict (name) do nothing;
