-- Allow the new "Returned from Dispensary" adjustment reason.
--
-- stock_adjustment_log.reason is guarded by a CHECK constraint that whitelists
-- the valid reasons. The pharmacy Adjustment page now offers "Returned from
-- Dispensary" (an internal store↔dispensary move), so add it to the whitelist —
-- otherwise the insert is rejected at the DB. Idempotent; safe to re-run.
--
-- NOTE: must be run manually on prod (migrations don't auto-run on deploy), and
-- BEFORE the frontend that offers the reason goes live.

alter table stock_adjustment_log drop constraint if exists stock_adjustment_log_reason_check;

alter table stock_adjustment_log add constraint stock_adjustment_log_reason_check
  check (reason = any (array[
    'Expired',
    'Damaged',
    'Lost / Stolen',
    'Physical count correction',
    'Returned to store',
    'Returned from Dispensary',
    'Returned from DSD',
    'Returned from SDP',
    'State Office',
    'Other'
  ]))
  not valid;
