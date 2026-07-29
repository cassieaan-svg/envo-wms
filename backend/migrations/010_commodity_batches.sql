-- One row per received lot. batch_number is the lot/serial code that gets tracked
-- through to whichever facility the stock is dispatched to.
CREATE TABLE commodity_batches (
  id SERIAL PRIMARY KEY,
  commodity_id INTEGER NOT NULL REFERENCES commodities(id),
  vendor_id INTEGER REFERENCES vendors(id),
  batch_number TEXT NOT NULL,
  expiry_date DATE NOT NULL,
  unit_cost NUMERIC(12,2),
  quantity_received NUMERIC(12,2) NOT NULL CHECK (quantity_received > 0),
  quantity_remaining NUMERIC(12,2) NOT NULL CHECK (quantity_remaining >= 0),
  received_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(commodity_id, batch_number)
);

-- FEFO dispatch reads batches for a commodity in expiry order.
CREATE INDEX commodity_batches_fefo_idx
  ON commodity_batches (commodity_id, expiry_date)
  WHERE quantity_remaining > 0;

-- Expiry alerts scan by date across all commodities.
CREATE INDEX commodity_batches_expiry_idx ON commodity_batches (expiry_date);
