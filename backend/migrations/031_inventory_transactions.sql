-- Transaction identity for every inventory-changing operation.
--
-- The problem: nothing in the warehouse could tell a retry from a second issue. A dispatch
-- whose response was lost to a dropped connection looked, to the server, exactly like a
-- store officer issuing the same stock again — so the client retried, the stock moved
-- twice, and the ledger recorded two movements for one physical handover. The only
-- protection that existed was UNIQUE(commodity_id, batch_number) on receiving, and 226 of
-- the 228 batches on hand have no batch number at all (see 021), so in practice a repeated
-- receipt created a second lot in silence.
--
-- The fix is a caller-supplied id that names the LOGICAL transaction — generated before the
-- request is sent, reused unchanged on every retry of that same transaction. The unique
-- index below is what actually enforces it: two requests carrying the same id contend on
-- the index, one inserts, the other is turned away and reads back the first one's result.
-- Application code alone could not do this — two concurrent requests would both look and
-- both find nothing.
--
-- WHY A HEADER TABLE, not a column on batch_movements. One dispatch draws FEFO across as
-- many lots as it needs, writing one movement per lot. A unique client_txn_id on the
-- movement row would reject the second lot of a perfectly legitimate two-lot draw. The id
-- belongs to the transaction; the movements hang off it.
--
-- `result` stores the response the first attempt produced, so a retry is answered with the
-- original order/batch rather than a conflict error — the caller cannot tell it was a
-- replay, which is the point.
--
-- `actor_user_id` is recorded so a transaction id can never become an authorization
-- mechanism: a replay is only served to the user whose transaction it was (see
-- IdempotencyService.claim). Guessing someone else's id gets a 409, not their data.
--
-- EXISTING DATA. Both additions are nullable and nothing is backfilled. All 277 existing
-- batch_movements rows keep txn_id NULL and stay exactly as they are; historical inventory
-- is not rewritten. The partial unique index only sees rows written from now on.
--
-- Apply:  npm run migrate
--
-- Down:
--   DROP INDEX IF EXISTS batch_movements_txn_idx;
--   ALTER TABLE batch_movements DROP COLUMN IF EXISTS txn_id;
--   DROP TABLE IF EXISTS inventory_transactions;

BEGIN;

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id            SERIAL PRIMARY KEY,
  -- The caller's id for this logical transaction. Text rather than uuid: a ULID is the
  -- natural choice for a client-generated, time-sortable id and is not a uuid.
  client_txn_id TEXT NOT NULL,
  operation     TEXT NOT NULL CHECK (operation IN (
                  'receipt', 'dispatch', 'adjustment', 'dispatch_edit', 'request_fulfil')),
  -- Who. The account is the security subject; `actor` is the name typed on the form,
  -- which is the person who physically handled the stock (store logins are shared).
  actor_user_id INTEGER REFERENCES users(id),
  actor         TEXT,
  -- What it touched. Whichever of these applies is filled in; the rest stay NULL.
  batch_id          INTEGER REFERENCES commodity_batches(id),
  dispatch_order_id INTEGER REFERENCES dispatch_orders(id),
  request_id        INTEGER REFERENCES requests(id),
  -- The first attempt's response, replayed verbatim to a retry.
  result        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The whole point of the migration. Two concurrent requests with the same id serialise
-- here: the second blocks on the index until the first commits, then finds it.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_transactions_client_txn_uniq
  ON inventory_transactions (client_txn_id);

-- "What did this transaction do?" — the audit path from a client id to its movements.
ALTER TABLE batch_movements
  ADD COLUMN IF NOT EXISTS txn_id INTEGER REFERENCES inventory_transactions(id);

CREATE INDEX IF NOT EXISTS batch_movements_txn_idx
  ON batch_movements (txn_id) WHERE txn_id IS NOT NULL;

COMMIT;
