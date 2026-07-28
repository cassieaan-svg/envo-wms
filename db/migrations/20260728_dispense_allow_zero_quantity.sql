-- Allow a ZERO-quantity consumption record. Facilities report daily consumption;
-- when nothing was consumed for a commodity that day, they still want a dated
-- "0 consumed" record so the report shows a reported entry rather than a gap.
--
-- A 0 debit is a no-op for stock (decrement by 0) and the lot ledger
-- (LotService.debit returns early), so no batch/expiry is required for these rows.
-- Relax the CHECK from (quantity > 0) to (quantity >= 0); negatives stay rejected.
--
-- Idempotent-ish: drop-if-exists then re-add. Run manually on prod before deploy.

alter table dispense_log drop constraint if exists dispense_log_quantity_check;
alter table dispense_log add constraint dispense_log_quantity_check check (quantity >= 0);
