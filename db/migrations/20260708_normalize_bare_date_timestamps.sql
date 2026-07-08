-- Normalize date-only log timestamps stored at bare UTC midnight to local
-- (Lagos) noon, matching how the app now anchors date-only entries.
--
-- A date entered as YYYY-MM-DD used to be saved as UTC midnight
-- (2026-07-06T00:00:00Z). In Lagos (UTC+1) that renders as "06 Jul 01:00" — a
-- meaningless time, and it would drift to the previous day for any viewer west
-- of UTC. Real events carry a random time-of-day (never exactly 00:00:00), so
-- only these date-anchored rows sit precisely on UTC midnight. Shifting +11h
-- lands them on 11:00 UTC = 12:00 Lagos, preserving the Lagos date and matching
-- new records (which now anchor at local noon).
--
-- Idempotent: after running, the rows sit at 11:00 UTC, so a re-run is a no-op.
-- NOTE: run manually on prod (migrations don't auto-run on deploy).

update intake_log set received_at = received_at + interval '11 hours'
  where to_char(received_at at time zone 'UTC', 'HH24:MI:SS') = '00:00:00';

update dispense_log set dispensed_at = dispensed_at + interval '11 hours'
  where to_char(dispensed_at at time zone 'UTC', 'HH24:MI:SS') = '00:00:00';

update stock_adjustment_log set adjusted_at = adjusted_at + interval '11 hours'
  where to_char(adjusted_at at time zone 'UTC', 'HH24:MI:SS') = '00:00:00';
