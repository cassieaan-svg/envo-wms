-- Allow 'Opening balance' as an adjustment reason.
--
-- WHY. A bin card's opening balance is SOH minus the sum of recorded movements —
-- a back-solved plug. When stock exists that no record explains (go-live seeding,
-- training data, records loaded without the matching stock), the plug is non-zero
-- and the bin card opens with a number nobody can trace.
--
-- A physical count CANNOT clear it: a count raises the shelf and adds a matching
-- correction to the records, moving both sides of the subtraction equally, so the
-- gap survives untouched. (Verified: SOH 0/movements -400/opening 400 -> count 100
-- -> SOH 100/movements -300/opening still 400.)
--
-- What clears it is making the unexplained quantity EXPLICIT: one dated record
-- saying "this bin started with N". That is what real bin cards do — an opening
-- balance is a line item, not a silent plug. Once recorded, movements sum to SOH
-- and the opening reads 0, with the baseline visible and attributable instead of
-- hidden.
--
-- This reason is RECORD-ONLY where fix_opening_balance.mjs posts it: it documents
-- stock already on the shelf, so it must NOT move stock again. It is excluded from
-- the CRRF for the same reason a stock-count variance is — it is not an inflow or
-- outflow of the programme's inventory.
--
-- Run manually on prod (migrations do not auto-apply here). Idempotent.

alter table stock_adjustment_log drop constraint if exists stock_adjustment_log_reason_check;
alter table stock_adjustment_log add constraint stock_adjustment_log_reason_check
  check (reason = any (array[
    'Expired', 'Damaged', 'Lost / Stolen',
    'Opening balance',             -- documents pre-existing stock (new)
    'Stock count variance',        -- derived from a physical count
    'Physical count correction',   -- retired; historical rows only
    'Returned to store', 'Returned from Dispensary', 'Returned from DSD',
    'Returned from SDP', 'State Office', 'Other'
  ])) not valid;
