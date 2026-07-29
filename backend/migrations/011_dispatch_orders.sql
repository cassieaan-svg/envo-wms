-- A dispatch to a facility is a multi-line document: this is the header.
CREATE TABLE dispatch_orders (
  id SERIAL PRIMARY KEY,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  total_amount NUMERIC(14,2) NOT NULL,
  dispatched_by TEXT,
  dispatched_at TIMESTAMPTZ DEFAULT now(),
  notes TEXT
);

CREATE INDEX dispatch_orders_facility_idx ON dispatch_orders (facility_id, dispatched_at DESC);
