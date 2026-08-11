-- Correcting a dispatched order.
--
-- A dispatch is a stock movement, not just a document: quantities have already been taken
-- out of specific lots. So an edit can't simply overwrite the rows — it has to put the
-- original quantities back where they came from, then take the new quantities out again.
-- That reversal is recorded in the ledger like any other movement, which is why
-- batch_movements gains a 'reversal' type rather than quietly reusing 'adjustment'
-- (adjustments mean a physical correction — damage, a recount — and shouldn't be confused
-- with an amended paperwork trail).
--
-- The order keeps a note of who last amended it and how many times, so a figure that has
-- been changed after the fact is never silently different from the printed copy someone
-- is holding.

ALTER TABLE dispatch_orders ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ;
ALTER TABLE dispatch_orders ADD COLUMN IF NOT EXISTS edited_by  TEXT;
ALTER TABLE dispatch_orders ADD COLUMN IF NOT EXISTS edit_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE batch_movements DROP CONSTRAINT IF EXISTS batch_movements_movement_type_check;
ALTER TABLE batch_movements ADD CONSTRAINT batch_movements_movement_type_check
  CHECK (movement_type IN ('receipt', 'dispatch', 'adjustment', 'reversal'));
