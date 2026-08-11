-- Outbound calls to EnVo, persisted before they're attempted.
--
-- These were previously fire-and-forget: three retries over about nine seconds, then the
-- failure was swallowed into a log line. If EnVo was unreachable for longer than that — a
-- restart, a network cut, a night with the link down — EnVo never learned the request had
-- been dispatched, and the facility saw it stuck forever with the stock already gone.
--
-- Now every callback is written here first and drained by a background worker with
-- backoff, so delivery survives an outage or a process restart. Rows are kept after
-- delivery as an audit trail of what was told to EnVo and when.

CREATE TABLE IF NOT EXISTS outbox (
  id              SERIAL PRIMARY KEY,
  kind            TEXT NOT NULL,             -- 'request_status' — the callback to make
  payload         JSONB NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ
);

-- The worker's claim query: undelivered rows that are due, oldest first.
CREATE INDEX IF NOT EXISTS outbox_due_idx
  ON outbox (next_attempt_at)
  WHERE delivered_at IS NULL;
