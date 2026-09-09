-- Measurement table for the pending-transfer counterparty exception.
--
-- THE THING BEING MEASURED. scope.js grants a facility-level user READ access to
-- another facility's `stock` when the two are parties to a PENDING transfer:
--
--   scope.js:172-174  scopedReadFacilityIds  — widens the list scope
--   scope.js:223      enforceFacilityRead    — grants a single-facility read
--
-- Both go through pendingTransferCounterparties(). The exception was ported from
-- a Supabase RLS sub-select and no frontend call path is known to depend on it,
-- but "no known caller" is inference about an access path, which is not good
-- enough to remove an authorization rule. This table replaces the inference with
-- a count.
--
-- ONE ROW PER (day, call site, facility). Aggregated in memory and flushed
-- periodically — see backend/src/services/counterpartyProbe.js. The probe never
-- changes an authorization decision; it only counts.
--
-- WHAT IS DELIBERATELY NOT RECORDED: no user id, no commodity, no request path,
-- no quantities. facility_id is organisational, not personal, and is the whole
-- point of the measurement — it says WHICH facilities would lose access if the
-- exception were removed. Nothing else is needed to make that decision.
--
-- No foreign key to facilities on purpose: a bookkeeping insert must never be
-- able to fail a request path, and a facility deleted mid-cycle would do exactly
-- that.
--
-- Run manually on prod (migrations do not auto-apply here).

create table if not exists counterparty_probe (
  -- Calendar day of the observation, so a reporting cycle is a date range.
  day                  date        not null,
  -- 'list'    → scopedReadFacilityIds (widens a multi-facility stock list)
  -- 'single'  → enforceFacilityRead   (the sole possible grant for one facility)
  -- 'unknown' → call site not identifiable from the stack; should stay at zero
  call_site            text        not null,
  -- The ACTING facility (the user's own facility), not the counterparty.
  facility_id          uuid        not null,
  -- Total times the exception was evaluated at this site for this facility.
  observations         bigint      not null default 0,
  -- Of those, how many returned at least one counterparty — i.e. how often the
  -- exception actually reached beyond the caller's own facility. This is the
  -- number that decides the rule's fate.
  widened              bigint      not null default 0,
  -- Largest counterparty set seen that day: how far the reach extended.
  max_counterparties   int         not null default 0,
  last_seen            timestamptz not null default now(),
  primary key (day, call_site, facility_id)
);

comment on table counterparty_probe is
  'Phase 2K measurement of the scope.js pending-transfer counterparty exception. Counts only; grants nothing.';
