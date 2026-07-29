-- Merge the "Medical supplies" category into "Pharmacy drugs". The pharmacy
-- section no longer distinguishes the two — condoms/lubricant and other supplies
-- become plain Pharmacy drugs. Section stays pharmacy either way, so this is a
-- pure re-label with no stock/log impact.
--
-- The "Condoms & Lubricants" CRRF form still works: it identifies those items by
-- the CRRF template/aliases (by name), not by this category.
--
-- Idempotent. Run manually on prod before deploy.

update commodities set category = 'Pharmacy drugs' where category = 'Medical supplies';
