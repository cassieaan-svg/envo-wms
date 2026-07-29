-- Append-only ledger: every quantity change to a batch is a row here, so each batch
-- sent out can be traced to the order line and facility that consumed it.
CREATE TABLE batch_movements (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES commodity_batches(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('receipt', 'dispatch', 'adjustment')),
  quantity NUMERIC(12,2) NOT NULL,   -- positive in, negative out
  facility_id INTEGER REFERENCES facilities(id),
  dispatch_order_item_id INTEGER REFERENCES dispatch_order_items(id),
  note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX batch_movements_batch_idx ON batch_movements (batch_id, created_at);
CREATE INDEX batch_movements_order_item_idx ON batch_movements (dispatch_order_item_id);
