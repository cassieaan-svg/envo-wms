-- Allow the new "Returned from DSD" / "Returned from SDP" adjustment reasons.
--
-- The stock_adjustment_log.reason column has a CHECK constraint
-- (stock_adjustment_log_reason_check) that whitelists reason strings. The
-- return-from-site feature adds two new reasons, so the constraint must be
-- rebuilt to include them, otherwise inserts fail with:
--   new row for relation "stock_adjustment_log" violates check constraint
--   "stock_adjustment_log_reason_check"
--
-- Run this once in the Supabase SQL editor (Database → SQL editor).
-- NOT VALID makes the ALTER succeed without re-validating existing rows; the
-- rule is still enforced on every new insert/update.

ALTER TABLE public.stock_adjustment_log
  DROP CONSTRAINT IF EXISTS stock_adjustment_log_reason_check;

ALTER TABLE public.stock_adjustment_log
  ADD CONSTRAINT stock_adjustment_log_reason_check
  CHECK (reason IN (
    'Expired',
    'Damaged',
    'Lost / Stolen',
    'Physical count correction',
    'Returned to store',
    'Returned from DSD',
    'Returned from SDP',
    'State Office',
    'Other'
  )) NOT VALID;
