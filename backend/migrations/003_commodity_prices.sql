CREATE TABLE commodity_prices (
  id SERIAL PRIMARY KEY,
  commodity_id INTEGER NOT NULL REFERENCES commodities(id),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  brand_name TEXT,
  unit_price NUMERIC(12,2) NOT NULL,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  is_current BOOLEAN DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Only one current price per commodity+vendor+brand. COALESCE so NULL brands collide
-- like any other value (a plain UNIQUE would let unlimited NULL-brand current rows through).
CREATE UNIQUE INDEX commodity_prices_one_current
  ON commodity_prices (commodity_id, vendor_id, COALESCE(brand_name, ''))
  WHERE is_current;

CREATE INDEX commodity_prices_commodity_idx ON commodity_prices (commodity_id);
