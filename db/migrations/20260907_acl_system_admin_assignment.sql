-- Phase 2M.1: give accounts carrying access_level='system_admin' their ACL role.
--
-- WHY A SEPARATE MIGRATION. The Phase 2D seed (20260903_acl_seed_user_roles.sql)
-- maps the six legacy access levels and deliberately ignores anything else — an
-- unrecognised value gets NO role rather than a guessed one, which is how
-- 'hq_tools' was correctly excluded. 'system_admin' is new vocabulary, so it needs
-- its own mapping rather than a loosening of that one.
--
-- NO SCOPE ROWS, IN ANY DIMENSION. Unscoped means unconstrained, which is exactly
-- how overall_admin's national reach is already represented (Phase 2D chose an
-- absent scope over a wildcard for the same reason). A system_admin is national by
-- definition, and — per the Phase 2M.1 decision — must NOT be given a facility,
-- section or module scope merely to make a screen render. Its capability comes
-- from role_permissions, which grants it user administration and nothing else.
--
-- THIS GRANTS NO OPERATIONAL ACCESS. system_admin holds exactly three permissions
-- (user.read, user.write, user_permission.write). It appears in neither
-- READ_ADMIN_LEVELS nor WRITE_ADMIN_LEVELS in scope.js, and carries no facility_id,
-- so every facility-scoped guard denies it twice over. Verified by
-- aclSystemAdmin.test.js rather than assumed.
--
-- Shadow-only: scope.js is untouched and nothing reads these rows in the request
-- path.
--
-- Idempotent. Re-run by aclProvisioning.syncAcl() on every provisioning call, so
-- the `not exists` guard matters for lock footprint, not just correctness — see
-- the note in 20260907_acl_module_dimension.sql.
--
-- Run manually on prod (migrations do not auto-apply here). Local development
-- only for now.

insert into user_roles (user_id, role_id, scope_type, scope_id)
select u.id, r.id, '', ''
  from users u
  cross join roles r
 where r.name = 'system_admin'
   and u.raw_user_meta_data->>'access_level' = 'system_admin'
   and not exists (select 1 from user_roles ur where ur.user_id = u.id)
on conflict (user_id, role_id, scope_type, scope_id) do nothing;
