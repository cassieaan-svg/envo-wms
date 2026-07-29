-- One line per commodity on a dispatch order. unit_price is stored as entered by the
-- admin (may differ from the current catalogue price), line_total computed app-side.
CREATE TABLE dispatch_order_items (
  id SERIAL PRIMARY KEY,
  dispatch_order_id INTEGER NOT NULL REFERENCES dispatch_orders(id) ON DELETE CASCADE,
  commodity_id INTEGER NOT NULL REFERENCES commodities(id),
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL,
  line_total NUMERIC(14,2) NOT NULL
);

CREATE INDEX dispatch_order_items_order_idx ON dispatch_order_items (dispatch_order_id);
