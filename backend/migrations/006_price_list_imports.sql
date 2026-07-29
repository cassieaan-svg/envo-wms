CREATE TABLE price_list_imports (
  id SERIAL PRIMARY KEY,
  filename TEXT,
  imported_by TEXT,
  imported_at TIMESTAMPTZ DEFAULT now(),
  row_count INTEGER,
  notes TEXT,
  committed_at TIMESTAMPTZ
);
