-- markPicking and reject now claim a transaction identity too (see requestService.js) —
-- neither moves stock, but each triggers a real EnVo-bound side effect (a status_event that
-- syncs to Cloud and from there becomes an EnVo callback), and a retried call must not raise
-- that twice. Extends the operation allowlist migration 034 already set up for exactly this
-- purpose.
ALTER TABLE inventory_transactions DROP CONSTRAINT IF EXISTS inventory_transactions_operation_check;
ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_operation_check CHECK (
  operation IN ('receipt', 'dispatch', 'adjustment', 'dispatch_edit', 'request_fulfil', 'payment',
                'request_mark_picking', 'request_reject')
);
