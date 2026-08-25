-- Add three commodities to the HIV catalogue (2026-08-25).
--
--   Cryovials (White)                    → Lab consumables
--   Izal (1 Litre)                       → Lab consumables
--   TDF/3TC/EFV 300/300/400mg (90 tabs)  → Pharmacy drugs
--
-- Column values follow the nearest existing siblings rather than being invented:
--   * Cryovials (White) mirrors Cryovials (Red)/(Blue) — unit 'piece', no pack_size.
--   * TDF/3TC/EFV mirrors the other TDF/3TC regimens — unit 'bottles',
--     dispensing_unit 'tablet', pack_size '90 tablets', and the tablet count in the
--     name, matching 'TDF/3TC/DTG 300/300/50mg (90 tabs)'.
--   * Izal (1 Litre) is a NEW row, not a rename. An 'Izal' already exists but it
--     belongs to the ESSENTIAL module (4L, priced) — a different catalogue.
--
-- IDEMPOTENT, AND SAFE TO RE-RUN AFTER THE FOLLOW-UPS.
-- The first version of this file inserted TDF/3TC/EFV without its tablet count and
-- a follow-up renamed it. Re-running that version then re-created the row under the
-- OLD name — the guard looked for a name that no longer existed — leaving two rows
-- for one commodity and breaking the rename on the next pass with a unique-key
-- violation. Inserting the final name here removes that trap: the guard matches the
-- name this file itself writes, whatever order the migrations are run in.
insert into commodities (name, category, unit, pack_size, dispensing_unit, module)
select v.name, v.category, v.unit, v.pack_size, v.dispensing_unit, v.module
from (values
  ('Cryovials (White)',                   'Lab consumables', 'piece',   null,          null,     'hiv'),
  ('Izal (1 Litre)',                      'Lab consumables', 'bottles', null,          'bottle', 'hiv'),
  ('TDF/3TC/EFV 300/300/400mg (90 tabs)', 'Pharmacy drugs',  'bottles', '90 tablets',  'tablet', 'hiv')
) as v(name, category, unit, pack_size, dispensing_unit, module)
where not exists (
  select 1 from commodities c where c.name = v.name and c.module = v.module
)
-- Belt and braces: `commodities_name_unique` means a name collision would abort the
-- whole batch. Where the row already exists under this exact name, do nothing.
on conflict (name) do nothing;
