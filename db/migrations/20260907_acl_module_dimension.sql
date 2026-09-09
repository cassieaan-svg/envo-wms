-- Phase 2M: `module` as a THIRD scope dimension, and the HQ section scopes.
--
-- WHY A DIMENSION AND NOT A scope_type. The obvious move is to add
-- scope_type='module' inside the existing commodity dimension. That is wrong, and
-- the HQ viewers are what expose it.
--
-- Resolution is OR WITHIN a dimension, AND ACROSS dimensions. If module and
-- section were both commodity rows, Lab HQ would resolve as
--
--     (module = hiv)  OR  (section = lab)     →  every HIV category
--
-- which is precisely the widening this is meant to prevent. As its own dimension
-- it resolves as
--
--     (module = hiv)  AND  (section = lab)    →  lab categories only
--
-- which is right. An empty module dimension still means unconstrained, so this
-- migration changes no decision until the backfill below adds rows.
--
-- THE LATENT WIDENING THIS CLOSES. 42 accounts (31 lga_admin, 5 state_admin,
-- 3 overall_admin, 3 state_viewer) carry NO commodity scope row at all, which
-- means unconstrained — so at cutover they would see Essential Commodities as
-- well as HIV. The confirmed rule is that overall_admin sees all sections of the
-- HIV module and no Essential Commodities at all.
--
-- Every account that exists today was provisioned for the HIV programme, so all
-- of them get module=hiv — not only the 42. Relying on category names to keep the
-- modules apart works today (the two category sets are disjoint) but is not a
-- boundary: the first Essential category that collides with an HIV one would
-- breach it silently. An explicit module row is the boundary.
--
-- Shadow-only: nothing reads these rows in the request path. scope.js is
-- untouched.
--
-- Idempotent. Run manually on prod (migrations do not auto-apply here). Local
-- development only for now.

-- ── 1. Allow the new dimension ──────────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'user_role_scopes'::regclass
       and conname = 'user_role_scopes_dimension_check'
  ) then
    alter table user_role_scopes drop constraint user_role_scopes_dimension_check;
  end if;
  alter table user_role_scopes
    add constraint user_role_scopes_dimension_check
    check (dimension in ('geography', 'commodity', 'module'));
end $$;

-- ── 2. Backfill: every existing account belongs to the HIV module ───────────
-- essential_admin and system_admin are deliberately excluded rather than filtered
-- by "no rows yet": the exclusion is the rule, and writing it down keeps a future
-- account of either kind from silently acquiring HIV scope the next time this
-- runs. essential_admin belongs to a different module; system_admin is national
-- and unscoped in every dimension by design (Phase 2M.1) — giving it a module row
-- to make a screen render is exactly what that decision forbids.
--
-- The `not exists` guard is not redundant with `on conflict do nothing`. This
-- migration is re-run on every provisioning call (aclProvisioning.MIGRATIONS), and
-- `on conflict` still has to TAKE A ROW LOCK on all ~7,500 existing rows before
-- discarding them. That long write transaction deadlocked against a concurrent
-- user delete cascading into this same table. With the guard, a steady-state
-- re-run inserts nothing and locks nothing.
insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
select ur.user_id, ur.role_id, 'module', 'module', 'hiv'
  from user_roles ur
  join roles r on r.id = ur.role_id
 where r.name not in ('essential_admin', 'system_admin')
   and not exists (
     select 1 from user_role_scopes s
      where s.user_id = ur.user_id and s.role_id = ur.role_id and s.dimension = 'module')
on conflict do nothing;

-- ── 3. HQ viewers become section-scoped variants of overall_admin ───────────
-- Lab HQ, Pharmacy HQ and M&E HQ are provisioned as overall_admin tagged with a
-- commodity_section, and create_hq_viewers.mjs describes that tag as being "so
-- the UI shows only that section's data". That is literally true today and it is
-- the problem: attachScope discards commodity_section for overall_admin
--
--     const bothSections = isAdminFlag || ['overall_admin','state_admin'].includes(accessLevel)
--
-- so the pin is enforced nowhere on the server. A frontend-only field is acting
-- as an access boundary. Carrying the pin into a commodity scope row makes it
-- real.
--
-- overall_admin accounts with NO section tag get no row here and keep seeing all
-- HIV sections, which is the confirmed rule.
--
-- EXPECT A NEW SHADOW MISMATCH. These accounts get NARROWER than legacy — the
-- safe direction, and an intended fix rather than a regression. It should be
-- recorded as its own class alongside the existing four.
--
-- The 'me' section is NOT seeded here. Its category ('M&E Tools'), its items and
-- the M&E HQ account all belong to the envo-tools branch and land when it merges;
-- seeding a section this branch cannot resolve would deny M&E HQ everything.
insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
select ur.user_id, ur.role_id, 'commodity', 'section',
       u.raw_user_meta_data->>'commodity_section'
  from user_roles ur
  join roles r on r.id = ur.role_id
  join users u on u.id = ur.user_id
 where r.name = 'overall_admin'
   and u.raw_user_meta_data->>'commodity_section' in ('pharmacy', 'lab')
   and not exists (
     select 1 from user_role_scopes s
      where s.user_id = ur.user_id and s.role_id = ur.role_id
        and s.dimension = 'commodity' and s.scope_type = 'section')
on conflict do nothing;
