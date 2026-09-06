-- Phase 2G: multi-dimensional scope.
--
-- user_roles carries ONE (scope_type, scope_id) pair, which geography already
-- consumes. That is why the ACL model cannot express department scope, the
-- Alere Determine commodity exception, or the hub-store category override —
-- see docs/authorization/authorization-model.md and gap-closure-design.md.
--
-- Scope becomes a SET of rows across two dimensions:
--   geography  — facility | state | cluster | lga
--   commodity  — section  | category | commodity
--
-- Resolution: OR within a dimension, AND across dimensions, a dimension with no
-- rows is UNCONSTRAINED on that dimension.
--
-- ADDITIVE AND REVERSIBLE. user_roles.scope_type/scope_id are left in place and
-- untouched; nothing reads this new table yet (the resolver is shadow-only and
-- scope.js remains authoritative). Dropping user_role_scopes restores the prior
-- state exactly.
--
-- Run manually on prod (migrations do not auto-apply here). Local development
-- only for now.

create table if not exists user_role_scopes (
  user_id    uuid not null,
  role_id    uuid not null,
  dimension  text not null check (dimension in ('geography', 'commodity')),
  scope_type text not null,
  scope_id   text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, role_id, dimension, scope_type, scope_id),
  -- FK on user_id only. A composite FK to user_roles (user_id, role_id) cannot be
  -- declared: that table's primary key is four columns, and adding a two-column
  -- unique constraint would forbid a user holding the same role at two different
  -- scopes — which the schema deliberately allows and aclFoundation.test.js
  -- explicitly asserts.
  --
  -- The (user_id, role_id) pair is therefore enforced by test rather than by
  -- constraint (see aclUserRoleScopes.test.js, "no scope row references a
  -- non-existent role assignment"). This resolves itself later: once geography
  -- lives here, user_roles's own scope columns become vestigial and its primary
  -- key can shrink to (user_id, role_id), at which point the composite FK can be
  -- added properly.
  foreign key (user_id) references users (id) on delete cascade
);

-- "Which users hold scope over this thing" — the reverse lookup. The primary key
-- already covers (user_id, role_id, …) for the forward direction.
create index if not exists idx_user_role_scopes_lookup
  on user_role_scopes (dimension, scope_type, scope_id);

-- ── Backfill: geography ─────────────────────────────────────────────────────
-- Straight 1:1 copy of the existing pair. overall_admin's deliberately empty
-- scope ('' / '') is NOT copied — an absent dimension already means
-- unconstrained, which is exactly what that empty pair encodes. Copying it would
-- create a row whose scope_id matches no facility, inverting its meaning.
insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
select ur.user_id, ur.role_id, 'geography', ur.scope_type, ur.scope_id
  from user_roles ur
 where ur.scope_type <> '' and ur.scope_id <> ''
on conflict do nothing;

-- ── Backfill: commodity ─────────────────────────────────────────────────────
-- Mirrors attachScope() exactly (scope.js:74-92). Three rules, in order:
--
--   1. overall_admin and state_admin are NEVER section-pinned — bothSections is
--      true for them regardless of the commodity_section on the account. Four
--      such users DO carry a section value; it is deliberately ignored here,
--      because the legacy code ignores it.
--   2. A hub store (state office / cluster lab store) has its section REPLACED
--      by the hub category set, not extended by it — so those users get category
--      rows, never a section row.
--   3. Everyone else pinned to their commodity_section gets one section row.
--      An account with no commodity_section gets no row at all = unconstrained.
with pinned as (
  select ur.user_id, ur.role_id,
         u.raw_user_meta_data->>'commodity_section' as section,
         f.name as facility_name
    from user_roles ur
    join users u on u.id = ur.user_id
    join roles r on r.id = ur.role_id
    left join facilities f on f.id::text = ur.scope_id
   where r.name not in ('overall_admin', 'state_admin')     -- rule 1
     and coalesce(u.raw_user_meta_data->>'commodity_section', '') <> ''
)
insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
-- rule 2: hub stores take the hub category set (lab consumables + general
-- consumables), replacing whatever section they carry.
select p.user_id, p.role_id, 'commodity', 'category', c.cat
  from pinned p
  cross join (values ('Lab consumables'), ('General Consumables')) as c(cat)
 where p.facility_name ~* 'state office store|cluster lab store'
union all
-- rule 3: everyone else keeps their section.
select p.user_id, p.role_id, 'commodity', 'section', p.section
  from pinned p
 where p.facility_name is null
    or p.facility_name !~* 'state office store|cluster lab store'
on conflict do nothing;

-- ── Backfill: the individual commodity exception ────────────────────────────
-- FACILITY_EXTRA_COMMODITIES currently hardcodes 'akwa ibom state office store'
-- -> 'Alere Determine' in constants/sections.js, keyed by facility NAME. As a
-- scope row it becomes data, and the facility name stops deciding access.
-- Additive by construction: rows within a dimension are OR-ed, so this widens
-- that one facility's commodity scope exactly as the constant does today.
insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
select ur.user_id, ur.role_id, 'commodity', 'commodity', c.id::text
  from user_roles ur
  join facilities f on f.id::text = ur.scope_id
  join commodities c on c.name = 'Alere Determine'
 where lower(btrim(f.name)) = 'akwa ibom state office store'
on conflict do nothing;
