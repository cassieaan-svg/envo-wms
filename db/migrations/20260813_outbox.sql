-- Durable delivery of outbound service-to-service calls to the WMS (mirrors the WMS's own
-- outbox for its EnVo callbacks). The first user is the receipt confirmation: when a
-- facility signs for a delivery, EnVo credits its stock and must tell the WMS who
-- received it. That call used to be fire-and-forget — if the WMS was down at that moment,
-- the warehouse never learned the recipient. Now the call is written here in the same
-- transaction as the receipt, and a worker delivers it once the WMS is reachable again.
--
-- Apply:  psql "$DATABASE_URL" -f db/migrations/20260813_outbox.sql
-- Idempotent.

create table if not exists outbox (
  id              bigserial primary key,
  kind            text not null,
  payload         jsonb not null,
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at    timestamptz,
  last_error      text,
  created_at      timestamptz not null default now()
);

-- The worker scans for undelivered rows that are due.
create index if not exists outbox_due_idx on outbox (next_attempt_at) where delivered_at is null;
