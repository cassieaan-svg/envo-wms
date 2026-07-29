CREATE TABLE facilities (
  id SERIAL PRIMARY KEY,
  envo_facility_id TEXT UNIQUE,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  lga TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX facilities_state_idx ON facilities (state);
