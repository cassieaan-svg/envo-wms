CREATE TABLE facility_commodities (
  id SERIAL PRIMARY KEY,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  commodity_id INTEGER NOT NULL REFERENCES commodities(id),
  is_default BOOLEAN DEFAULT FALSE,
  added_by TEXT,
  added_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(facility_id, commodity_id)
);
