-- Partial disputes: record how much of a disputed transfer the receiver kept
-- and how much went back to the sending facility.
--
-- A dispute used to be all-or-nothing: the whole dispatched quantity returned to
-- the sender. A receiver who accepts part of a delivery (say 4 of 6, the rest
-- damaged) now records both halves, and the stock is split to match — the kept
-- quantity is credited to the destination, the rest back to the sender's store.
--
-- qty_accepted + qty_returned always equals the dispatched quantity on rows
-- written by the new flow.
--
-- Apply:  psql "$DATABASE_URL" -f db/migrations/20260720_transfer_partial_dispute.sql
-- Idempotent; safe to re-run.
--
-- NOTE: must be run manually on prod (migrations don't auto-run on deploy), and
-- BEFORE the backend that writes these columns goes live.

begin;

alter table stock_transfer_log add column if not exists qty_accepted integer;
alter table stock_transfer_log add column if not exists qty_returned integer;

comment on column stock_transfer_log.qty_accepted is
  'Disputed transfers: quantity the receiver kept.';
comment on column stock_transfer_log.qty_returned is
  'Disputed transfers: quantity returned to the sending facility.';

-- Backfill: every dispute recorded before this change returned the whole
-- dispatched quantity, so state those two halves explicitly rather than leaving
-- them NULL. Only touches rows that have not been split yet.
update stock_transfer_log
   set qty_accepted = 0,
       qty_returned = quantity
 where status = 'disputed'
   and qty_accepted is null;

commit;
