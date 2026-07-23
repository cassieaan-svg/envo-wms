-- Lot ledger phase 2: carry the drawn lots on a transfer.
--
-- A transfer debits the sender's lots at dispatch/approve but credits the
-- receiver's lots at a SEPARATE step (accept / receive). So the exact batch+expiry
-- lots that were drawn have to travel with the transfer. `lots` holds them as
-- [{ "batch": "...", "expiry": "YYYY-MM-DD", "qty": N }] — the receiver is credited
-- with exactly these, and a dispute splits them into the accepted vs returned
-- portions. Internal store→dispensary moves atomically and doesn't use this.
--
-- Apply BEFORE the phase-2 backend goes live. Idempotent.

begin;
alter table stock_transfer_log add column if not exists lots jsonb;
commit;
