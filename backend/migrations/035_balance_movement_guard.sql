-- quantity_remaining may not move without the ledger moving with it.
--
-- THE DEFECT THIS CLOSES. All three discrepancies in the development database were
-- out-of-band UPDATEs: the balance column was changed with no movement to explain it. For
-- batch 18 that is provable rather than inferred — allocateFefo only selects batches with
-- quantity_remaining > 0, and the ledger says the balance was 0 at the moment a dispatch of
-- -1 was recorded against it, so something raised the column without writing a movement.
-- Nothing in the application can do that; it came from outside. A rule in the application
-- would not have stopped it, which is why this one lives in the database.
--
-- WHAT IT ENFORCES. At COMMIT, for every batch whose row was inserted or updated:
--
--     quantity_remaining = SUM(batch_movements.quantity) + allowed_variance
--
-- DEFERRED, so it is checked once the whole transaction has been written. It has to be:
-- every legitimate path writes the balance and the movement as two separate statements, and
-- an immediate trigger would fire between them and reject correct work.
--
-- WHY ABSOLUTE, NOT A DELTA. The obvious rule — "this update's delta must equal the
-- movements written in this transaction" — breaks on a real path. DispatchService.updateOrder
-- reverses an order and then re-draws it, touching the SAME batch twice in one transaction.
-- A row trigger fires once per event with the OLD/NEW captured at that event, so the first
-- event would compare its own delta (+100, the reversal) against the transaction's net
-- movement (+40), and reject a perfectly correct edit. Re-reading the row and checking the
-- invariant absolutely is immune to that: it does not matter how many times the balance was
-- touched or in what order, only that it agrees with the ledger when the dust settles.
--
-- ALLOWED VARIANCE, AND WHY IT IS NOT A BYPASS. Three batches already disagree with their
-- ledger. They are historical, they predate the transaction identity added in Phase 1, and
-- fixing them requires someone to walk to the shelf and count. Enforcing a bare
-- quantity_remaining = SUM(movements) would freeze them: every dispatch, adjustment and
-- reversal touching them would fail until counted, which is an outage caused by a refactor.
--
-- So the migration measures the variance that exists AT THE MOMENT IT IS APPLIED and carries
-- it forward as an explicit, named allowance. That is not forgiveness: the row records the
-- discrepancy, reconciliation still reports it, and the allowance can only be retired by an
-- attributed physical count (see ReconciliationService.resolveByCount). Crucially it is
-- seeded ONLY from variance that already exists — a new discrepancy created after this
-- migration has no allowance and is rejected outright.
--
-- No history is rewritten and no movement is fabricated. The three batches keep exactly the
-- figures they have today.
--
-- Apply:  npm run migrate
--
-- Down:
--   DROP TRIGGER IF EXISTS commodity_batches_balance_guard ON commodity_batches;
--   DROP FUNCTION IF EXISTS enforce_balance_backed_by_movement();
--   DROP TABLE IF EXISTS batch_balance_variance;

BEGIN;

-- The measured, grandfathered gap for a batch. One row per batch, only ever seeded by this
-- migration and only ever removed by an attributed count.
CREATE TABLE IF NOT EXISTS batch_balance_variance (
  batch_id   INTEGER PRIMARY KEY REFERENCES commodity_batches(id),
  variance   NUMERIC(14,2) NOT NULL,
  -- What the two sides said when the allowance was granted, so the record still means
  -- something after later movements have changed the ledger.
  balance_at_grant NUMERIC(14,2) NOT NULL,
  ledger_at_grant  NUMERIC(14,2) NOT NULL,
  note       TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed from what is actually there. On a clean database this inserts nothing.
INSERT INTO batch_balance_variance (batch_id, variance, balance_at_grant, ledger_at_grant, note)
SELECT b.id,
       b.quantity_remaining - COALESCE(SUM(m.quantity), 0),
       b.quantity_remaining,
       COALESCE(SUM(m.quantity), 0),
       'pre-existing at 035; awaiting physical count'
  FROM commodity_batches b
  LEFT JOIN batch_movements m ON m.batch_id = b.id
 GROUP BY b.id
HAVING b.quantity_remaining <> COALESCE(SUM(m.quantity), 0)
ON CONFLICT (batch_id) DO NOTHING;

CREATE OR REPLACE FUNCTION enforce_balance_backed_by_movement()
RETURNS TRIGGER AS $$
DECLARE
  current_balance NUMERIC;
  ledger_balance  NUMERIC;
  allowed         NUMERIC;
BEGIN
  -- Re-read rather than trusting NEW: this fires at commit, and NEW is a snapshot from
  -- whenever the statement ran. The current row is what the transaction is actually leaving
  -- behind. A row updated and then deleted in the same transaction has nothing to check.
  SELECT quantity_remaining INTO current_balance
    FROM commodity_batches WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(quantity), 0) INTO ledger_balance
    FROM batch_movements WHERE batch_id = NEW.id;

  SELECT COALESCE(variance, 0) INTO allowed
    FROM batch_balance_variance WHERE batch_id = NEW.id;
  allowed := COALESCE(allowed, 0);

  IF current_balance <> ledger_balance + allowed THEN
    RAISE EXCEPTION '%', format(
      'batch %s balance (%s) does not match its ledger (%s%s) — every change to '
      || 'quantity_remaining must be accompanied by a batch_movements row in the same transaction',
      NEW.id, current_balance, ledger_balance,
      CASE WHEN allowed <> 0 THEN format(' plus allowed variance %s', allowed) ELSE '' END)
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'Record the movement that explains this change. To close a known variance, use an attributed physical count.';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- A CONSTRAINT TRIGGER so it can be DEFERRED to commit. INSERT is covered as well as
-- UPDATE: a batch created with an opening quantity and no movement is the same defect,
-- and importStocktake creates batches exactly that way (it writes the movement too).
DROP TRIGGER IF EXISTS commodity_batches_balance_guard ON commodity_batches;
CREATE CONSTRAINT TRIGGER commodity_batches_balance_guard
  AFTER INSERT OR UPDATE ON commodity_batches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_balance_backed_by_movement();

COMMIT;
