CREATE TABLE commodities (
  id SERIAL PRIMARY KEY,
  envo_commodity_id TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
