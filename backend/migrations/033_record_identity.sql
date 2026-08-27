-- Globally unique record identity, and where a record came from.
--
-- WHY NOW, BEFORE THERE IS A SECOND INSTANCE. Every key in this database is a SERIAL. That
-- is fine for one writer and unresolvable for two: a local warehouse instance and the cloud
-- would both mint dispatch_orders.id = 8, for different orders, and no merge could tell
-- them apart or repair it afterwards. A row created before this migration can never be
-- given a trustworthy global identity retroactively, so the column goes in now and starts
-- filling itself immediately — long before anything reads it.
--
-- `uid` sits ALONGSIDE the integer id rather than replacing it. Rewriting every primary and
-- foreign key on live warehouse data would be a far larger and riskier change than this
-- phase can justify, and nothing yet depends on uid being the key. Internal joins keep
-- using id; anything crossing an instance boundary later uses uid.
--
-- gen_random_uuid() is volatile, so ADD COLUMN evaluates it once PER ROW: every existing
-- record gets its own distinct uid as part of this migration. That rewrites the table, which
-- at this size (228 batches, 277 movements, single-digit orders) is instant. On a table of
-- millions it would need the add/backfill/set-not-null dance instead.
--
-- ORIGIN. `origin` records which instance authored a row, and `source_instance` names it.
-- Existing rows default to 'cloud' because that is what this deployment is: today's single
-- WMS becomes the Cloud WMS in the target architecture, and everything in it was authored
-- here. Backfilling any other value would be inventing history.
--
-- This migration adds columns and indexes only. It does not change how anything behaves.
--
-- Apply:  npm run migrate
--
-- Down:
--   ALTER TABLE commodity_batches      DROP COLUMN IF EXISTS uid, DROP COLUMN IF EXISTS origin, DROP COLUMN IF EXISTS source_instance;
--   ALTER TABLE batch_movements        DROP COLUMN IF EXISTS uid, DROP COLUMN IF EXISTS origin, DROP COLUMN IF EXISTS source_instance;
--   ALTER TABLE dispatch_orders        DROP COLUMN IF EXISTS uid, DROP COLUMN IF EXISTS origin, DROP COLUMN IF EXISTS source_instance;
--   ALTER TABLE dispatch_order_items   DROP COLUMN IF EXISTS uid;
--   ALTER TABLE inventory_transactions DROP COLUMN IF EXISTS uid, DROP COLUMN IF EXISTS origin, DROP COLUMN IF EXISTS source_instance;

BEGIN;

-- ── Identity ────────────────────────────────────────────────────────────────
ALTER TABLE commodity_batches      ADD COLUMN IF NOT EXISTS uid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE batch_movements        ADD COLUMN IF NOT EXISTS uid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE dispatch_orders        ADD COLUMN IF NOT EXISTS uid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE dispatch_order_items   ADD COLUMN IF NOT EXISTS uid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS uid UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS commodity_batches_uid_key      ON commodity_batches (uid);
CREATE UNIQUE INDEX IF NOT EXISTS batch_movements_uid_key        ON batch_movements (uid);
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_orders_uid_key        ON dispatch_orders (uid);
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_order_items_uid_key   ON dispatch_order_items (uid);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_transactions_uid_key ON inventory_transactions (uid);

-- ── Origin ──────────────────────────────────────────────────────────────────
-- Only on the rows that record an event. A dispatch_order_item is part of its order and
-- inherits the order's origin; giving it one of its own would let the two disagree.
ALTER TABLE commodity_batches      ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE batch_movements        ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE dispatch_orders        ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'cloud';

-- Which named deployment wrote it (WMS_INSTANCE_ID). `origin` says what kind of instance,
-- this says which one — they differ the moment there is more than one warehouse.
ALTER TABLE commodity_batches      ADD COLUMN IF NOT EXISTS source_instance TEXT;
ALTER TABLE batch_movements        ADD COLUMN IF NOT EXISTS source_instance TEXT;
ALTER TABLE dispatch_orders        ADD COLUMN IF NOT EXISTS source_instance TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source_instance TEXT;

-- 'cms' is the local central medical store instance; 'cloud' is this one. Constrained so a
-- typo in configuration cannot quietly write rows nothing will recognise later.
ALTER TABLE commodity_batches      DROP CONSTRAINT IF EXISTS commodity_batches_origin_check;
ALTER TABLE commodity_batches      ADD CONSTRAINT commodity_batches_origin_check      CHECK (origin IN ('cloud', 'cms'));
ALTER TABLE batch_movements        DROP CONSTRAINT IF EXISTS batch_movements_origin_check;
ALTER TABLE batch_movements        ADD CONSTRAINT batch_movements_origin_check        CHECK (origin IN ('cloud', 'cms'));
ALTER TABLE dispatch_orders        DROP CONSTRAINT IF EXISTS dispatch_orders_origin_check;
ALTER TABLE dispatch_orders        ADD CONSTRAINT dispatch_orders_origin_check        CHECK (origin IN ('cloud', 'cms'));
ALTER TABLE inventory_transactions DROP CONSTRAINT IF EXISTS inventory_transactions_origin_check;
ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_origin_check CHECK (origin IN ('cloud', 'cms'));

-- "What did the local warehouse author since <time>?" — the question a sync engine will ask.
CREATE INDEX IF NOT EXISTS batch_movements_origin_idx
  ON batch_movements (origin, created_at);

COMMIT;
