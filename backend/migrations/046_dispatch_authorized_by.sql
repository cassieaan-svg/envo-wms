-- "Authorized by" at the point of dispatch: who approved stock leaving the store, recorded
-- beside dispatched_by (who physically released it).
--
-- On both tables because there are two dispatch paths: a direct dispatch writes only a
-- dispatch_orders row, while fulfilling a facility request writes the request's own row AND
-- a dispatch order over the same handover, and each is read on its own (the requests screen
-- and dispatch history).
--
-- Nullable, with no backfill: every dispatch made before this column existed genuinely has
-- no recorded authoriser, and inventing one would be worse than showing a dash. The screens
-- require it going forward; the API stays lenient so an older client or a queued retry is
-- not refused over a field it never knew about.
--
-- Apply:  npm run migrate   (on Cloud as well as CMS — the sync envelope now carries it)

ALTER TABLE dispatch_orders ADD COLUMN IF NOT EXISTS authorized_by TEXT;
ALTER TABLE requests        ADD COLUMN IF NOT EXISTS authorized_by TEXT;
