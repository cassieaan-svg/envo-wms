-- Let the balance guard distinguish authoring from mirroring.
--
-- THE PROBLEM. The guard (035) holds that a batch's quantity_remaining must equal the sum of
-- its movements. That is exactly right for the instance that AUTHORS the stock: nothing may
-- change the balance without a movement explaining it.
--
-- It is not achievable for a MIRROR. Cloud receives one transaction at a time, and the
-- balance CMS reports reflects the batch's whole history — so a dispatch envelope for a
-- batch whose earlier movements Cloud has not received yet arrives with a balance the
-- movements in that envelope cannot account for. This is not an edge case: a CMS instance
-- commissioned from a database snapshot has batches whose history predates the sync
-- entirely, and their first envelope will always look like this.
--
-- Sending each batch's full ledger with every envelope would fix it and is the wrong trade:
-- it grows without bound on exactly the long-lived batches that move most often.
--
-- SO: the guard skips when the transaction has declared itself a mirror ingest. Three things
-- keep that from being a way around it:
--   * it is SET LOCAL — scoped to one transaction, gone at commit, never a session default;
--   * only SyncService.ingest sets it, and ingest refuses anything not authored by CMS;
--   * it changes nothing on CMS, where every write still has to explain itself, because CMS
--     never runs ingest.
--
-- What replaces the guard on the mirror is reconciliation: Cloud's copy is checked against
-- what CMS reports rather than against its own partial ledger. A mirror whose ledger is
-- incomplete for pre-sync history is expected, and is visible as such.
--
-- Apply:  npm run migrate
--
-- Down: restore the 035 body of enforce_balance_backed_by_movement() (drop the two lines
--       that read envo.mirror_ingest).

BEGIN;

CREATE OR REPLACE FUNCTION enforce_balance_backed_by_movement()
RETURNS TRIGGER AS $$
DECLARE
  current_balance NUMERIC;
  ledger_balance  NUMERIC;
  allowed         NUMERIC;
BEGIN
  -- Mirroring, not authoring. See the note above.
  IF COALESCE(current_setting('envo.mirror_ingest', true), '') = 'on' THEN
    RETURN NULL;
  END IF;

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

COMMIT;
