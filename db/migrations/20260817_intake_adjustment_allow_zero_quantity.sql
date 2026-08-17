-- Allow a ZERO-quantity intake and stock adjustment, so a mistaken entry can be
-- cancelled by editing it to 0 the way a dispense already can (see
-- 20260728_dispense_allow_zero_quantity.sql).
--
-- Editing the quantity moves the stock by the same delta inside the same
-- transaction (LogService.updateLog), so setting a record to 0 returns the bin to
-- what it held before that record existed. Without this, the only way to reverse a
-- wrong intake was a compensating adjustment, which fixes the balance but leaves
-- the false receipt standing in the record, in the bin card and in the reports.
--
-- The row is kept rather than deleted, so the edit history still shows what was
-- originally entered and who cancelled it. Negatives stay rejected: they would
-- invert the movement rather than cancel it.
--
-- NOTE for whoever applies this: cancelling an intake or an Increase adjustment
-- REMOVES stock, unlike a dispense which returns it. If that stock has already been
-- consumed or moved on, the bin cannot give it back. LogService.updateLog refuses
-- with a 409 when ENFORCE_BIN_STOCK is true; with it off (the current default) it
-- clamps the bin at zero and only warns to the server log.
--
-- Idempotent-ish: drop-if-exists then re-add. Run manually on prod before deploy.

alter table intake_log drop constraint if exists intake_log_quantity_check;
alter table intake_log add constraint intake_log_quantity_check check (quantity >= 0);

alter table stock_adjustment_log drop constraint if exists stock_adjustment_log_quantity_check;
alter table stock_adjustment_log add constraint stock_adjustment_log_quantity_check check (quantity >= 0);
