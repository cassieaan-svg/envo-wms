-- Make a movement say which order it belonged to, and keep saying it after an edit.
--
-- TWO GAPS, ONE COLUMN.
--
-- 1. A request fulfilment drew stock with `itemId: null` (RequestService.fulfil called
--    allocateFefo before the dispatch order existed), so its movements had no link to any
--    order at all. Seven such rows are in this database: stock left the warehouse and the
--    ledger cannot say on which document.
--
-- 2. Editing a dispatch order NULLs dispatch_order_item_id on that order's movements. That
--    is not gratuitous — the old dispatch_order_items rows are deleted and re-created, and
--    the foreign key would block the delete otherwise — but it means an amended order loses
--    the trail from its movements back to itself, including the reversal rows that explain
--    the amendment.
--
-- Both are fixed by linking movements to the ORDER as well as to the line. The order
-- survives an edit (only its lines are rewritten), so this link is never nulled, and it
-- answers the question that actually matters when tracing stock: which document moved it.
-- dispatch_order_item_id stays exactly as it is, for the line-level detail, and is still
-- nulled on edit because the foreign key requires it.
--
-- BACKFILL is derived, never guessed: only movements that already carry a line link can
-- have their order inferred, and that inference is exact. The seven orphaned fulfilment
-- movements are deliberately LEFT NULL — their order genuinely was never recorded, and
-- inventing one would be worse than an honest gap. They stay visible as unlinked.
--
-- facility_id is backfilled by the same rule and from the same source.
--
-- Also extends inventory_transactions.operation to cover payments, which gain transaction
-- identity in this phase.
--
-- Apply:  npm run migrate
--
-- Down:
--   DROP INDEX IF EXISTS batch_movements_order_idx;
--   ALTER TABLE batch_movements DROP COLUMN IF EXISTS dispatch_order_id;
--   ALTER TABLE dispatch_order_payments DROP COLUMN IF EXISTS txn_id;
--   (the operation CHECK reverts to the 031 list)

BEGIN;

ALTER TABLE batch_movements
  ADD COLUMN IF NOT EXISTS dispatch_order_id INTEGER REFERENCES dispatch_orders(id);

-- Exact derivation from the line link that already exists. Rows without one are untouched.
UPDATE batch_movements m
   SET dispatch_order_id = i.dispatch_order_id
  FROM dispatch_order_items i
 WHERE i.id = m.dispatch_order_item_id
   AND m.dispatch_order_id IS NULL;

-- Same rule, same source: a movement on an order went to that order's facility.
UPDATE batch_movements m
   SET facility_id = o.facility_id
  FROM dispatch_orders o
 WHERE o.id = m.dispatch_order_id
   AND m.facility_id IS NULL;

-- "Every movement this order caused", including reversals, across any number of edits.
CREATE INDEX IF NOT EXISTS batch_movements_order_idx
  ON batch_movements (dispatch_order_id) WHERE dispatch_order_id IS NOT NULL;

-- Payments are money changing hands and are now claimed like any other transaction.
ALTER TABLE inventory_transactions DROP CONSTRAINT IF EXISTS inventory_transactions_operation_check;
ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_operation_check CHECK (
  operation IN ('receipt', 'dispatch', 'adjustment', 'dispatch_edit', 'request_fulfil', 'payment')
);

ALTER TABLE dispatch_order_payments
  ADD COLUMN IF NOT EXISTS txn_id INTEGER REFERENCES inventory_transactions(id);

COMMIT;
