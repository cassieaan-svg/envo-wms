-- A fulfilled request now also writes a dispatch_orders record, so request fulfilments
-- appear in the warehouse's dispatch history alongside directly-created dispatches. This
-- links the request to the order it produced (one order per fulfilment).
ALTER TABLE requests ADD COLUMN IF NOT EXISTS dispatch_order_id INTEGER REFERENCES dispatch_orders(id);
