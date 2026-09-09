-- Phase 2D: migrate existing users into user_roles, from their current
-- raw_user_meta_data.access_level and its matching scope field.
--
-- DATA ONLY, PARALLEL COPY. This migration does not touch `users` in any way —
-- not raw_user_meta_data, not access_level, not any scope field. The legacy
-- representation remains fully intact and fully authoritative: nothing in
-- scope.js or auth.js reads user_roles, so this migration cannot change any
-- authorization decision by construction.
--
-- ROLE MAPPING is a direct 1:1 copy of the six approved access_level values —
-- no renaming, no new roles, no hq_tools, no facility_role (verified zero
-- backend authorization effect in Phase 2A — never migrated).
--
-- SCOPE MAPPING is copied verbatim from the exact field attachScope() itself
-- reads for each access level (backend/src/middleware/scope.js:66-107,
-- 113-127), re-verified against the current code before writing this file:
--   facility      -> scope_type='facility', scope_id=raw_user_meta_data.facility_id
--   state_admin   -> scope_type='state',    scope_id=raw_user_meta_data.admin_state
--   state_viewer  -> scope_type='state',    scope_id=raw_user_meta_data.admin_state
--   cluster_admin -> scope_type='cluster',  scope_id=raw_user_meta_data.admin_cluster
--   lga_admin     -> scope_type='lga',      scope_id=raw_user_meta_data.admin_lga
--   overall_admin -> scope_type='',         scope_id=''  (attachScope never narrows it)
-- This matched the expected model exactly; no discrepancy was found, so nothing
-- was reported as needing to stop.
--
-- MISSING access_level (465 local users) DEFAULTS TO 'facility' — this is not a
-- guess. attachScope() itself does exactly this: `let accessLevel = 'facility';
-- if (meta.access_level) accessLevel = meta.access_level`. A user with no
-- access_level key already RUNS as a facility user today; migrating them as
-- 'facility' reproduces current behavior, it does not invent new behavior.
--
-- UNKNOWN access_level (e.g. 'hq_tools') IS DELIBERATELY EXCLUDED. No branch in
-- scope.js or attachScope assigns 'hq_tools' any meaning; it is not a defined
-- default the way a missing value is. This migration seeds no role for it. See
-- the Phase 2D report for the affected user; a future phase must decide its
-- correct treatment rather than this migration guessing at one.
--
-- Idempotent: `on conflict do nothing` against the (user_id, role_id, scope_type,
-- scope_id) primary key, matching the house convention.
--
-- Run manually on prod (migrations do not auto-apply here) — targets the LOCAL
-- development database only for now.

with eligible as (
  -- The exact same fold attachScope performs: a present access_level is used
  -- verbatim; an absent/empty one becomes 'facility'. Anything else (there is
  -- currently exactly one other value in the data: 'hq_tools') is excluded by
  -- the `in (...)` filter below rather than silently folded to anything.
  select
    id                                   as user_id,
    coalesce(nullif(raw_user_meta_data->>'access_level', ''), 'facility') as access_level,
    raw_user_meta_data->>'facility_id'   as facility_id,
    raw_user_meta_data->>'admin_state'   as admin_state,
    raw_user_meta_data->>'admin_cluster' as admin_cluster,
    raw_user_meta_data->>'admin_lga'     as admin_lga
  from users
),
mapped as (
  select
    user_id,
    access_level as role_name,
    case access_level
      when 'facility'      then 'facility'
      when 'state_admin'   then 'state'
      when 'state_viewer'  then 'state'
      when 'cluster_admin' then 'cluster'
      when 'lga_admin'     then 'lga'
      when 'overall_admin' then ''
    end as scope_type,
    -- coalesce to '' (never NULL) to match the NOT NULL DEFAULT '' columns —
    -- a genuinely missing scope value is preserved AS EMPTY, which is the most
    -- restrictive possible value, never a wildcard. See the Phase 2D report for
    -- the one local user this applies to (a facility-role account with no
    -- facility_id at all — already unable to access anything today).
    coalesce(
      case access_level
        when 'facility'      then facility_id
        when 'state_admin'   then admin_state
        when 'state_viewer'  then admin_state
        when 'cluster_admin' then admin_cluster
        when 'lga_admin'     then admin_lga
        when 'overall_admin' then ''
      end,
      '') as scope_id
  from eligible
  -- Only the six approved values are eligible — this is what excludes 'hq_tools'
  -- (or any future unrecognized value) rather than defaulting it to anything.
  where access_level in ('facility', 'state_admin', 'state_viewer',
                          'cluster_admin', 'lga_admin', 'overall_admin')
)
insert into user_roles (user_id, role_id, scope_type, scope_id)
select m.user_id, r.id, m.scope_type, m.scope_id
  from mapped m
  join roles r on r.name = m.role_name
on conflict (user_id, role_id, scope_type, scope_id) do nothing;
