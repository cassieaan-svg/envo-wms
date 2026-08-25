-- TDF/3TC/EFV is a 90-tablet bottle (confirmed 2026-08-25).
--
-- 20260825_add_commodities.sql now inserts the final name and pack size directly,
-- so on a database that never ran the earlier version of that file this does
-- nothing. It exists for databases where the FIRST version already ran and created
-- 'TDF/3TC/EFV 300/300/400mg' without the tablet count.
--
-- The `not exists` guard matters: a database holding BOTH names would otherwise hit
-- `commodities_name_unique` and abort the batch. Skipping leaves the stray row to be
-- removed deliberately, rather than a migration guessing which one holds the history.
--
-- No reference to commodities.module - see the note in 20260825_add_commodities.sql.
update commodities c
   set name = 'TDF/3TC/EFV 300/300/400mg (90 tabs)',
       pack_size = '90 tablets'
 where c.name = 'TDF/3TC/EFV 300/300/400mg'
   and not exists (
     select 1 from commodities x where x.name = 'TDF/3TC/EFV 300/300/400mg (90 tabs)'
   );
