-- TDF/3TC/EFV is a 90-tablet bottle (confirmed 2026-08-25).
--
-- 20260825_add_commodities.sql created it without a pack size, because the count
-- was not known at the time and the sibling ARVs carry one. This finishes the row:
-- the name gains the count, matching 'TDF/3TC 300/300mg (30 tabs)' and
-- 'TDF/3TC/DTG 300/300/50mg (90 tabs)', and pack_size gains '90 tablets' so the
-- dispensing maths has the same basis as its siblings.
--
-- A follow-up rather than an edit to the original: that file is already applied
-- locally and pushed, so changing its INSERT would leave the two databases holding
-- rows with different names under the same migration. This converges both.
--
-- Idempotent: matches nothing once applied, and nothing at all if the row was
-- already created with its final name.
update commodities
   set name = 'TDF/3TC/EFV 300/300/400mg (90 tabs)',
       pack_size = '90 tablets'
 where name = 'TDF/3TC/EFV 300/300/400mg'
   and module = 'hiv';
