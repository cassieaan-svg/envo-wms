-- TDF/3TC/EFV is a 90-tablet bottle (confirmed 2026-08-25).
--
-- 20260825_add_commodities.sql now inserts the final name and pack size directly,
-- so on a database that has never seen the earlier version of that file this does
-- nothing. It exists for databases where the FIRST version already ran and created
-- 'TDF/3TC/EFV 300/300/400mg' with no tablet count — it brings those into line.
--
-- The `not exists` guard is the important part. Without it, a database holding BOTH
-- names (which the earlier, re-runnable-but-wrong version could produce) would hit
-- `commodities_name_unique` and abort the batch. Here the rename is skipped when the
-- correct row is already present, leaving the stray to be removed deliberately
-- rather than by a migration guessing which one carries the history.
update commodities c
   set name = 'TDF/3TC/EFV 300/300/400mg (90 tabs)',
       pack_size = '90 tablets'
 where c.name = 'TDF/3TC/EFV 300/300/400mg'
   and c.module = 'hiv'
   and not exists (
     select 1 from commodities x
      where x.name = 'TDF/3TC/EFV 300/300/400mg (90 tabs)'
        and x.module = 'hiv'
   );
