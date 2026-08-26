-- The receipt the store issues to the facility for a payment.
--
-- This is the STORE's own receipt number, not the bank teller/deposit slip reference
-- that was deliberately left out of 029: a facility pays into the bank and brings the
-- teller, and the store then issues it a receipt. That receipt is what the facility
-- holds as proof, so the balance needs to name it — otherwise a facility waving a
-- receipt has nothing in the system to match it against.
--
-- NULLABLE, and existing rows are NOT backfilled: payments recorded before receipts
-- were captured genuinely have no receipt number, and inventing one would fabricate a
-- document that was never issued. New payments require it at the API.
--
-- UNIQUE where present, so the same receipt cannot be recorded against two payments —
-- which is the mistake that makes a receipt useless as proof. Partial, so the
-- historical NULLs are unaffected.
--
-- Apply:  npm run migrate

BEGIN;

ALTER TABLE dispatch_order_payments
  ADD COLUMN IF NOT EXISTS receipt_no TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS dispatch_order_payments_receipt_no_key
  ON dispatch_order_payments (receipt_no)
  WHERE receipt_no IS NOT NULL;

COMMIT;
