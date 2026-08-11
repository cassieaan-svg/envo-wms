-- Phase 5: inbound facility requests from EnVo's Essential Commodities module. EnVo
-- POSTs a request; it lands here as 'pending' in the warehouse queue. The warehouse
-- prints a pick list, picks, and fulfils it ('dispatched'); each transition is echoed
-- back to EnVo via its status callback. envo_request_id ties the two systems' rows.
--
-- Prices are resolved here from the current commodity_prices (the master), so the total
-- the picker sees is authoritative. Batch-level FEFO depletion (DispatchService) can be
-- layered onto fulfil once the warehouse actually holds batch stock; today it holds none.
--
-- Apply:  npm run migrate   (or psql -f)

CREATE TABLE IF NOT EXISTS requests (
  id               SERIAL PRIMARY KEY,
  envo_request_id  TEXT UNIQUE,                -- EnVo's warehouse_requests.id (uuid), echoed back
  envo_facility_id TEXT,                        -- EnVo facility code, as sent
  facility_id      INTEGER REFERENCES facilities(id),
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending -> picking -> dispatched
  total_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  dispatched_at    TIMESTAMPTZ,
  dispatched_by    TEXT
);
CREATE INDEX IF NOT EXISTS requests_status_idx ON requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS request_items (
  id             SERIAL PRIMARY KEY,
  request_id     INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  commodity_id   INTEGER REFERENCES commodities(id),
  quantity       INTEGER NOT NULL,
  unit_price     NUMERIC(12,2),
  line_total     NUMERIC(14,2),
  qty_dispatched INTEGER
);
CREATE INDEX IF NOT EXISTS request_items_request_idx ON request_items (request_id);
