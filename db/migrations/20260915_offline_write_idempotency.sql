-- Idempotency for writes that will become offline-queueable (dispense first; intake,
-- adjustments, transfers, bincard follow the same recipe). See the envo-wms sibling
-- project's docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md for the full rationale. Short
-- version: a device
-- queues a write locally while offline and replays it on reconnect; without an identity
-- for the LOGICAL operation (not the HTTP request), a retried submit after a dropped
-- response looks identical to a second, real dispense, and the stock moves twice.
--
-- Mirrors envo-wms's inventory_transactions/IdempotencyService almost exactly — that
-- mechanism is already proven (two production-grade phases of testing), so this is a
-- port, not a new design. One generic table rather than one per operation type: this
-- app records dispense/intake/adjustments/transfers/bincard as five separate ledger
-- tables (not one unified batch table the way envo-wms has), so the identity table
-- has to stay generic across all of them rather than living on any single log table.

create table if not exists idempotent_operations (
  id uuid primary key default gen_random_uuid(),
  client_txn_id text not null,
  operation text not null,           -- 'dispense' | 'intake' | 'adjustment' | 'transfer' | 'bincard'
  actor_user_id uuid references users(id),
  facility_id uuid,
  result jsonb,
  created_at timestamptz not null default now()
);

-- One claim per client-supplied id. A second INSERT with the same id contends on this
-- index and loses — exactly the mechanism that makes claim-then-complete race-safe: two
-- concurrent identical requests cannot both believe they own the operation.
create unique index if not exists idempotent_operations_client_txn_id_key
  on idempotent_operations (client_txn_id);

create index if not exists idempotent_operations_facility_idx
  on idempotent_operations (facility_id, created_at);
