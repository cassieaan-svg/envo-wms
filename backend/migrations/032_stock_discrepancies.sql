-- Where reconciliation writes what it found.
--
-- The invariant the warehouse runs on is that a batch's remaining quantity equals the sum
-- of its movements: quantity_remaining == SUM(batch_movements.quantity). Until now nothing
-- checked it. Running that check by hand against the development database found three
-- batches already out of balance — one of them showing three dispatch movements against a
-- quantity that never moved, which is the "movement exists but stock did not change" state
-- the ledger is supposed to make impossible. The system had no way to notice.
--
-- A discrepancy is RECORDED HERE AND LEFT ALONE. It is deliberately not corrected: if
-- expected is 500 and the shelf says 480, the 20 went somewhere, and quietly writing 500
-- over it destroys the only evidence that anything happened. Correcting a count is a
-- physical act with a reason and a name against it — that is what a `count_correction`
-- adjustment is for, raised by someone who has been to the shelf and looked.
--
-- One open finding per batch, enforced by the partial unique index: re-running the check
-- updates the existing row rather than stacking a new one on every pass, so the open list
-- is "what is wrong now", not a log of how often we looked. History is kept by resolving a
-- finding rather than deleting it.
--
-- Nothing here runs on the normal write path. Reconciliation is invoked explicitly — by an
-- admin endpoint or scripts/reconcile.mjs — so a dispatch never pays for it.
--
-- Apply:  npm run migrate
--
-- Down:
--   DROP TABLE IF EXISTS stock_discrepancies;

BEGIN;

CREATE TABLE IF NOT EXISTS stock_discrepancies (
  id                SERIAL PRIMARY KEY,
  batch_id          INTEGER NOT NULL REFERENCES commodity_batches(id),
  -- expected = the ledger's answer (SUM of movements). actual = what the batch row claims.
  -- variance = actual - expected: positive means the shelf figure is higher than the
  -- movements justify, negative means stock left without a movement to explain it.
  expected_quantity NUMERIC(12,2) NOT NULL,
  actual_quantity   NUMERIC(12,2) NOT NULL,
  variance          NUMERIC(12,2) NOT NULL,
  -- What ran the check, so a finding can be traced to the pass that produced it.
  source            TEXT,
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Resolution is an explicit human act, never automatic.
  resolved_at       TIMESTAMPTZ,
  resolved_by       TEXT,
  resolution_note   TEXT
);

-- At most one OPEN finding per batch. Re-running the check updates it in place.
CREATE UNIQUE INDEX IF NOT EXISTS stock_discrepancies_open_uniq
  ON stock_discrepancies (batch_id) WHERE resolved_at IS NULL;

-- "What has been wrong with this batch, and when?"
CREATE INDEX IF NOT EXISTS stock_discrepancies_batch_idx
  ON stock_discrepancies (batch_id, detected_at DESC);

COMMIT;
