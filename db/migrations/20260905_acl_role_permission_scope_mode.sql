-- role_permissions.scope_mode — per-grant scope narrowing.
--
-- THE GAP THIS CLOSES. Legacy WRITE_ADMIN_LEVELS (scope.js) gives state_admin
-- cross-facility write on stock, dsd_stock, sdp_stock, amc_settings and
-- transfers — but maps dispense_log, intake_log and adjustment_log to an EMPTY
-- array, meaning no role gets cross-facility write on those at all. An admin is
-- not the person physically dispensing or receiving.
--
-- role_permissions could not express "this grant, for this role, does not widen
-- across facilities", so the Phase 2E resolver mirrored it with a code constant
-- (CROSS_FACILITY_WRITE_PERMISSIONS). That constant is the workaround this
-- column replaces: the rule moves from application code into data, which is the
-- point of the whole project.
--
--   inherit            use the role assignment's own scope (current behaviour)
--   own_facility_only  ignore any wider geographic scope; require the actor's
--                      own facility
--
-- DEFAULT 'inherit', so every existing grant behaves exactly as it does today
-- and the migration changes no decision on its own.
--
-- APPLIED TO EVERY ROLE HOLDING THOSE THREE PERMISSIONS, not just state_admin.
-- The legacy rule is a property of the TABLE (dispense_log: []), not of one
-- role — no role may write those logs outside its own facility. For the
-- `facility` role the setting is a no-op (its scope already IS its own
-- facility); recording it anyway keeps the data a faithful statement of the
-- rule rather than an artefact of which roles happen to exist today.
--
-- NOT applied to edit_history.write. Legacy applies no facility scoping to
-- edit_history whatsoever (routes/editHistory.js has no enforceFacilityWrite
-- call), so it is UNSCOPED in the resolver and scope_mode is irrelevant to it.
-- Marking it own_facility_only would invent a restriction that does not exist.
--
-- Shadow-only: scope.js remains authoritative and nothing in the request path
-- reads this column.
--
-- Run manually on prod (migrations do not auto-apply here). Local development
-- only for now.

alter table role_permissions
  add column if not exists scope_mode text not null default 'inherit';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'role_permissions'::regclass
       and conname = 'role_permissions_scope_mode_check'
  ) then
    alter table role_permissions
      add constraint role_permissions_scope_mode_check
      check (scope_mode in ('inherit', 'own_facility_only'));
  end if;
end $$;

-- The three log-write permissions never widen across facilities, for any role.
update role_permissions
   set scope_mode = 'own_facility_only'
 where permission_key in ('dispense_log.write', 'intake_log.write', 'adjustment_log.write')
   and scope_mode <> 'own_facility_only';
