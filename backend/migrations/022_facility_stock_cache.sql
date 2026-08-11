-- The facility stock view is proxied live from EnVo, so it breaks whenever the store
-- loses its internet — which is the normal condition this deployment is built for.
-- Keeping the last good payload lets the view degrade to "here is what we last knew"
-- instead of an error. One row per facility: only the most recent answer is useful.
CREATE TABLE facility_stock_cache (
  facility_id INTEGER PRIMARY KEY REFERENCES facilities(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
