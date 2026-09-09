-- Phase 2M: user-administration permissions, and the two roles that genuinely
-- need to exist.
--
-- WHY NEW PERMISSION KEYS. All 24 existing keys describe inventory actions —
-- stock, logs, transfers, reports, diagnostics. None describes administering
-- users, so the resolver cannot answer "may this administrator change that
-- user's role" at all: it returns 'role lacks permission', not because the
-- administrator is unauthorised but because the concept is absent from the
-- vocabulary.
--
-- The alternative was to hard-code the rule in the route, as
-- routes/commodities.js does for the catalogue (isCatalogueManager). That works,
-- but it puts the governance matrix into application code — the exact thing this
-- project has spent the ACL phases moving OUT of code and into data. Three keys
-- keeps it configurable.
--
-- WHY ONLY TWO NEW ROLES. The governance discussion named five candidates
-- (system_admin, Pharmacy admin, Laboratory admin, M&E admin, Essential
-- Commodities admin). Four of them turned out to be EXISTING roles plus a scope
-- row, which is what the multi-dimensional scope model is for:
--
--   Lab HQ / Pharmacy HQ / M&E HQ = overall_admin + a commodity `section` scope
--   a state-scoped section reader  = state_viewer  + a commodity `section` scope
--
-- Only two describe capabilities no existing role has:
--
--   system_admin     administers users and holds NO operational data access at
--                    all. A role that can grant itself any permission AND write
--                    stock has no meaningful check on it, so it writes neither.
--   essential_admin  read/write within the Essential Commodities module, which
--                    no current role reaches (every existing role is HIV).
--
-- SCOPE IS NOT IN HERE. "Within own state", "not above own level" and "Essential
-- module only" are scope and service-layer rules, not permissions. The permission
-- says WHETHER; the scope says OVER WHOM. See 20260907_acl_module_dimension.sql.
--
-- Shadow-only: nothing reads these rows in the request path. scope.js remains the
-- sole authorization authority and is untouched.
--
-- Idempotent throughout. Run manually on prod (migrations do not auto-apply
-- here). Local development only for now.

-- ── permissions (3) ─────────────────────────────────────────────────────────
insert into permissions (key, module, description) values
  ('user.read',             'user_admin', 'View the user list and a user''s role, scope and effective permissions'),
  ('user.write',            'user_admin', 'Change a user''s role and scope, within the actor''s own bounds'),
  ('user_permission.write', 'user_admin', 'Set a direct per-user grant/deny override (system_admin only)')
on conflict (key) do nothing;

-- ── roles (2) ───────────────────────────────────────────────────────────────
insert into roles (name, description, is_system) values
  ('system_admin',
   'Administers users, roles and scopes across the whole system. Holds NO operational data access by design.',
   true),
  ('essential_admin',
   'Essential Commodities module: read/write within an assigned geography, and administers Essential Commodities users in that scope.',
   true)
on conflict (name) do nothing;

-- ── mappings ────────────────────────────────────────────────────────────────

-- system_admin: the three user keys and nothing else. Deliberately no stock,
-- no logs, no transfers, no reports.
insert into role_permissions (role_id, permission_key)
select r.id, k.key
  from roles r
  cross join (values ('user.read'), ('user.write'), ('user_permission.write')) as k(key)
 where r.name = 'system_admin'
on conflict do nothing;

-- state_admin gains user administration. It already writes operational data, and
-- the governing rule settled in Phase 2M is that user administration requires
-- write capability — so the roles that manage users are exactly the roles that
-- can write. NOT user_permission.write: direct grant/deny stays with
-- system_admin alone.
insert into role_permissions (role_id, permission_key)
select r.id, k.key
  from roles r
  cross join (values ('user.read'), ('user.write')) as k(key)
 where r.name = 'state_admin'
on conflict do nothing;

-- essential_admin mirrors state_admin's operational capability EXACTLY, copied
-- from the data rather than re-listed. Re-typing the 24 keys here would create a
-- second source of truth that drifts the first time either changes — and it would
-- silently lose scope_mode, which is what stops the three log writes widening
-- across facilities. The module scope, not the permission set, is what confines
-- this role to Essential Commodities.
insert into role_permissions (role_id, permission_key, scope_mode)
select target.id, rp.permission_key, rp.scope_mode
  from role_permissions rp
  join roles src    on src.id = rp.role_id and src.name = 'state_admin'
  cross join roles target
 where target.name = 'essential_admin'
   and rp.permission_key not in ('user.read', 'user.write', 'user_permission.write')
on conflict do nothing;

-- …plus its own user administration, on the same "write implies user admin" rule.
insert into role_permissions (role_id, permission_key)
select r.id, k.key
  from roles r
  cross join (values ('user.read'), ('user.write')) as k(key)
 where r.name = 'essential_admin'
on conflict do nothing;
