-- Phase 2M.2: the essential_admin identity, and the module scope it was missing.
--
-- THE DEFECT THIS CLOSES. Phase 2M created the essential_admin role and excluded
-- it from the `module = hiv` backfill — correctly, it is not an HIV role — but
-- never gave it `module = essential` instead. An absent dimension means
-- UNCONSTRAINED, so the exclusion removed the wrong scope without supplying the
-- right one, leaving the role able to reach every module:
--
--     stock.write on an ESSENTIAL item   true
--     stock.write on an HIV item         true   <- wrong
--
-- Nothing was exposed, because no account has ever held the role. But
-- provisioning one before this migration would create a cross-module
-- administrator, which is the exact opposite of the boundary the module
-- dimension exists to draw. Seeding the scope and enabling the identity are
-- therefore ONE migration, in that order — never the identity alone.
--
-- SCOPE SHAPE
--   geography  state, from raw_user_meta_data.admin_state
--   module     essential
--   commodity  none — all six Essential categories. Sections (pharmacy/lab/me)
--              are an HIV concept and deliberately do not apply here.
--
-- NO FACILITY. Like system_admin, this account carries no facility_id, which is
-- half of why every facility guard in scope.js denies it (the other half being
-- that 'essential_admin' appears in neither READ_ADMIN_LEVELS nor
-- WRITE_ADMIN_LEVELS). Verified in aclEssentialAdmin.test.js rather than assumed.
--
-- PERMISSIONS ARE UNCHANGED AND DELIBERATELY SO. The role currently holds a
-- byte-identical copy of state_admin's 24 operational keys, which describe HIV
-- facility workflows — stock, dispensing, DSD/SDP, transfers — none of which the
-- Essential module has (it has priced requisitions: warehouse_requests,
-- commodities.unit_price, wms_commodity_id, and zero rows in stock/dispense/
-- transfer). That mismatch was reported and the decision was to DEFER: the keys
-- stay as they are until the Essential module is actually built, at which point
-- warehouse_request.* keys get declared alongside it. Trimming them now would
-- guess at a shape the module's own build would contradict.
--
-- The module scope is what makes the mismatch harmless in the meantime: those
-- keys cannot reach HIV data, and there is no Essential data for them to reach.
--
-- Shadow-only: scope.js is untouched and nothing reads these rows in the request
-- path.
--
-- Idempotent, and re-run by aclProvisioning.syncAcl() on every provisioning call
-- — hence the `not exists` guards, which keep the steady-state re-run from taking
-- row locks it does not need (see 20260907_acl_module_dimension.sql).
--
-- Run manually on prod (migrations do not auto-apply here). Local development
-- only for now.

-- ── 1. Role assignment ──────────────────────────────────────────────────────
-- scope_type/scope_id mirror the geography row. They are NOT vestigial: the
-- resolver's own_facility_only check still reads user_roles.scope_type.
insert into user_roles (user_id, role_id, scope_type, scope_id)
select u.id, r.id, 'state', coalesce(u.raw_user_meta_data->>'admin_state', '')
  from users u
  cross join roles r
 where r.name = 'essential_admin'
   and u.raw_user_meta_data->>'access_level' = 'essential_admin'
   and coalesce(u.raw_user_meta_data->>'admin_state', '') <> ''
   and not exists (select 1 from user_roles ur where ur.user_id = u.id)
on conflict (user_id, role_id, scope_type, scope_id) do nothing;

-- ── 2. Geography ────────────────────────────────────────────────────────────
insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
select ur.user_id, ur.role_id, 'geography', 'state', u.raw_user_meta_data->>'admin_state'
  from user_roles ur
  join roles r on r.id = ur.role_id
  join users u on u.id = ur.user_id
 where r.name = 'essential_admin'
   and coalesce(u.raw_user_meta_data->>'admin_state', '') <> ''
   and not exists (
     select 1 from user_role_scopes s
      where s.user_id = ur.user_id and s.role_id = ur.role_id and s.dimension = 'geography')
on conflict do nothing;

-- ── 3. Module — the fix ─────────────────────────────────────────────────────
-- Unconditional for the role: an essential_admin without this row is
-- cross-module, so this must apply to every holder regardless of how the
-- account was created.
insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
select ur.user_id, ur.role_id, 'module', 'module', 'essential'
  from user_roles ur
  join roles r on r.id = ur.role_id
 where r.name = 'essential_admin'
   and not exists (
     select 1 from user_role_scopes s
      where s.user_id = ur.user_id and s.role_id = ur.role_id and s.dimension = 'module')
on conflict do nothing;
