-- CMS is the price authority: pricing is decided operationally at the warehouse, not at
-- Cloud. commodity_prices had no uid/origin/source_instance — it was designed as pure
-- Cloud-authored master data mirrored down, with no path back (unlike commodity_batches,
-- dispatch_orders etc, which migration 033 already gave these columns because they were
-- always CMS-authored). This brings commodity_prices into the same record-identity scheme
-- those tables use, so a CMS-set price can be pushed up to Cloud and from there to EnVo,
-- instead of only ever being overwritten by the next Cloud->CMS master-data pull.
--
-- gen_random_uuid() is volatile, so ADD COLUMN evaluates it once per existing row — every
-- price already on hand gets a real, distinct uid, exactly as 033 did for the other tables.
ALTER TABLE commodity_prices ADD COLUMN IF NOT EXISTS uid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE commodity_prices ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'cms';
ALTER TABLE commodity_prices ADD COLUMN IF NOT EXISTS source_instance TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS commodity_prices_uid_idx ON commodity_prices (uid);
