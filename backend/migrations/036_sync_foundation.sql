-- Foundation for running this application as two instances: Cloud and CMS Local.
--
-- Phase 2 gave the five inventory tables a `uid` so a row could be named across instances.
-- This completes that coverage and adds the bookkeeping a sync needs: where each stream got
-- to, and whether a given transaction has reached Cloud yet.
--
-- WHAT DOES NOT NEED A uid, AND WHY. Master data (commodities, prices, facilities, schemes,
-- vendors) and the requests EnVo raises are authored by Cloud and only ever COPIED down to
-- CMS. CMS never invents one, so there is nothing to collide: the local rows keep Cloud's
-- integer ids verbatim, and every existing foreign key keeps working untouched. A uid there
-- would be a second identity for a row that already has an unambiguous one.
--
-- The tables that DO need it are the ones CMS authors itself, plus `users` (replicated down,
-- and worth naming stably for audit) and `requests`/`request_items` (Cloud-authored, but CMS
-- writes status back up and the envelope should name them without depending on integer ids
-- lining up).
--
-- SEQUENCES ARE NOT TOUCHED HERE. Giving CMS a disjoint id range is a per-instance act, not
-- a schema change — running it on Cloud would be wrong. See scripts/initCmsInstance.mjs,
-- which also refuses to proceed if Cloud has already grown past the CMS floor.
--
-- Additive and reversible. No historical row is rewritten.
--
-- Apply:  npm run migrate
--
-- Down:
--   DROP TABLE IF EXISTS sync_state;
--   ALTER TABLE inventory_transactions DROP COLUMN IF EXISTS synced_at, DROP COLUMN IF EXISTS sync_attempts;
--   ALTER TABLE requests DROP COLUMN IF EXISTS uid;  (and the other four)

BEGIN;

-- ── uid coverage ────────────────────────────────────────────────────────────
ALTER TABLE requests                 ADD COLUMN IF NOT EXISTS uid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE request_items            ADD COLUMN IF NOT EXISTS uid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE dispatch_order_payments  ADD COLUMN IF NOT EXISTS uid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE stock_discrepancies      ADD COLUMN IF NOT EXISTS uid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE users                    ADD COLUMN IF NOT EXISTS uid UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS requests_uid_key                ON requests (uid);
CREATE UNIQUE INDEX IF NOT EXISTS request_items_uid_key           ON request_items (uid);
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_order_payments_uid_key ON dispatch_order_payments (uid);
CREATE UNIQUE INDEX IF NOT EXISTS stock_discrepancies_uid_key     ON stock_discrepancies (uid);
CREATE UNIQUE INDEX IF NOT EXISTS users_uid_key                   ON users (uid);

-- Payments are authored at the store, so they carry the same provenance as a movement.
ALTER TABLE dispatch_order_payments ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE dispatch_order_payments ADD COLUMN IF NOT EXISTS source_instance TEXT;
ALTER TABLE dispatch_order_payments DROP CONSTRAINT IF EXISTS dispatch_order_payments_origin_check;
ALTER TABLE dispatch_order_payments ADD CONSTRAINT dispatch_order_payments_origin_check
  CHECK (origin IN ('cloud', 'cms'));

-- ── Where each sync stream got to ───────────────────────────────────────────
-- One row per stream ('master_data', 'requests', 'outbound'). Deliberately tiny: the
-- interesting state is WHEN a stream last succeeded, because that is what the staleness
-- policy reads and what the health endpoint reports.
CREATE TABLE IF NOT EXISTS sync_state (
  stream          TEXT PRIMARY KEY,
  -- Opaque to the database. For master data this is a content hash, so an unchanged
  -- snapshot costs nothing to apply; for requests it is the high-water mark.
  cursor          TEXT,
  last_success_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_error      TEXT,
  -- What the last successful pull actually brought in, for the operator's benefit.
  detail          JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Has this transaction reached Cloud? ─────────────────────────────────────
-- On CMS this is the sync watermark. On Cloud it stays NULL and means nothing, which is
-- correct: Cloud does not sync anywhere.
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;

-- "What is still waiting to go up?" — the pending-sync count the warehouse needs to see.
CREATE INDEX IF NOT EXISTS inventory_transactions_unsynced_idx
  ON inventory_transactions (created_at) WHERE synced_at IS NULL;

COMMIT;
