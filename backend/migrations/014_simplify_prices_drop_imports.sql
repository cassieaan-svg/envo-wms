-- A commodity has one price, set and adjusted directly by an admin. The vendor/brand
-- dimension on prices came from the bulk-import design and is gone: the source price list
-- never had a vendor column, so every imported price carried a placeholder vendor that
-- didn't reflect reality.

-- 1. Prices no longer belong to a vendor.
ALTER TABLE commodity_prices ALTER COLUMN vendor_id DROP NOT NULL;

-- 2. Strip the placeholder vendor attribution. The unit prices themselves are real (they
--    came from the price list) so the rows are kept; only the invented vendor link goes.
UPDATE commodity_prices SET vendor_id = NULL, brand_name = NULL;

-- 3. Where a commodity ended up with more than one current price (one per placeholder
--    vendor), keep the most recently created and retire the rest, so "current price"
--    is unambiguous before the new index goes on.
UPDATE commodity_prices cp
   SET is_current = FALSE
 WHERE cp.is_current
   AND cp.id <> (
     SELECT c2.id
       FROM commodity_prices c2
      WHERE c2.commodity_id = cp.commodity_id
        AND c2.is_current
      ORDER BY c2.effective_date DESC, c2.created_at DESC, c2.id DESC
      LIMIT 1
   );

-- 4. One current price per commodity, replacing the per-vendor/brand key.
DROP INDEX IF EXISTS commodity_prices_one_current;
CREATE UNIQUE INDEX commodity_prices_one_current
  ON commodity_prices (commodity_id)
  WHERE is_current;

-- 5. The bulk price-list import feature is removed; its staging tables go with it. This
--    has to happen before the vendor cleanup below, since staging rows reference vendors.
DROP TABLE IF EXISTS price_import_staging;
DROP TABLE IF EXISTS price_list_imports;

-- 6. Remove the placeholder vendors created while testing the import. Batches may
--    legitimately record a supplying vendor, so the vendors table itself stays.
DELETE FROM vendors
 WHERE name IN ('Emzor Pharmaceuticals', 'Fidson Healthcare')
   AND NOT EXISTS (SELECT 1 FROM commodity_batches b WHERE b.vendor_id = vendors.id)
   AND NOT EXISTS (SELECT 1 FROM commodity_prices p WHERE p.vendor_id = vendors.id);
