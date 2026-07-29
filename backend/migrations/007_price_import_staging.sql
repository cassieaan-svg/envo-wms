-- Parsed price-list rows land here for admin review. Nothing reaches commodity_prices
-- until the import is explicitly committed.
CREATE TABLE price_import_staging (
  id SERIAL PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES price_list_imports(id) ON DELETE CASCADE,
  source_row INTEGER,              -- S/N from the source document, for tracing back
  category TEXT,                   -- carried down from the category header row
  description TEXT NOT NULL,       -- becomes the commodity name
  unit TEXT,
  unit_price NUMERIC(12,2),
  remark TEXT,
  -- The source price list has no vendor/brand columns; admin supplies these during review.
  vendor_id INTEGER REFERENCES vendors(id),
  brand_name TEXT,
  commodity_id INTEGER REFERENCES commodities(id),  -- matched existing commodity, if any
  is_excluded BOOLEAN DEFAULT FALSE,                -- admin removed this row from the batch
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX price_import_staging_import_idx ON price_import_staging (import_id);
