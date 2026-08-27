-- Request status events, and reprint tracking.
--
-- STATUS EVENTS. A request's dispatch is an inventory transaction and therefore syncs. Its
-- other transitions — a store officer starting to pick, or rejecting a request the warehouse
-- cannot fill — move no stock, so nothing carried them to Cloud, and EnVo saw a request jump
-- from 'submitted' straight to 'dispatched'. Phase 5 surfaced that gap; this closes it.
--
-- Each transition becomes a ROW rather than just a column update, because a status change is
-- a fact that happened at a moment, and syncing "the current status" would lose the order
-- they happened in and give the receiving side no way to tell a replay from a new event.
-- The uid is what makes delivery idempotent: Cloud applies an event it has already seen by
-- doing nothing.
--
-- The current `requests.status` column stays exactly as it is and remains what the UI reads.
-- This table is the history beside it, not a replacement for it.
--
-- REPRINTS. A waybill that is printed twice must be distinguishable on paper, or two copies
-- of one dispatch circulate with nothing to say which is which. `print_count` drives the
-- label — the first is the Original, the next is REPRINT #1 — and each print is logged with
-- who took it and when. Printing moves no stock and writes no movement; that separation is
-- the whole point, and there is a test asserting it.
--
-- Additive and reversible. No historical row is rewritten.
--
-- Apply:  npm run migrate
--
-- Down:
--   DROP TABLE IF EXISTS dispatch_order_prints;
--   DROP TABLE IF EXISTS request_status_events;
--   ALTER TABLE dispatch_orders DROP COLUMN IF EXISTS print_count;

BEGIN;

CREATE TABLE IF NOT EXISTS request_status_events (
  id           SERIAL PRIMARY KEY,
  -- The wire identity. Cloud dedupes on this, so a re-delivered event is a no-op.
  uid          UUID NOT NULL DEFAULT gen_random_uuid(),
  request_id   INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  -- Carried explicitly: it is how Cloud addresses the request when telling EnVo, and it
  -- survives even if the local integer ids are ever renumbered.
  envo_request_id TEXT,
  status       TEXT NOT NULL CHECK (status IN ('picking', 'rejected', 'cancelled', 'dispatched')),
  actor        TEXT,
  note         TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin       TEXT NOT NULL DEFAULT 'cloud' CHECK (origin IN ('cloud', 'cms')),
  source_instance TEXT,
  -- Set on CMS when the event reaches Cloud. Always NULL on Cloud, which syncs nowhere.
  synced_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS request_status_events_uid_key ON request_status_events (uid);
CREATE INDEX IF NOT EXISTS request_status_events_request_idx
  ON request_status_events (request_id, occurred_at);
-- "What has not reached Cloud yet?" — the pending-status query.
CREATE INDEX IF NOT EXISTS request_status_events_unsynced_idx
  ON request_status_events (occurred_at) WHERE synced_at IS NULL;

-- ── Reprints ────────────────────────────────────────────────────────────────
ALTER TABLE dispatch_orders ADD COLUMN IF NOT EXISTS print_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS dispatch_order_prints (
  id                SERIAL PRIMARY KEY,
  uid               UUID NOT NULL DEFAULT gen_random_uuid(),
  dispatch_order_id INTEGER NOT NULL REFERENCES dispatch_orders(id) ON DELETE CASCADE,
  -- 0 is the original; 1 is REPRINT #1, and so on. Stored rather than derived so the label
  -- on a sheet of paper can always be traced to the exact record of it being taken.
  print_number      INTEGER NOT NULL,
  label             TEXT NOT NULL,
  printed_by        TEXT,
  printed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin            TEXT NOT NULL DEFAULT 'cloud',
  source_instance   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS dispatch_order_prints_uid_key ON dispatch_order_prints (uid);
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_order_prints_seq_key
  ON dispatch_order_prints (dispatch_order_id, print_number);

COMMIT;
