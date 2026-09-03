-- ACL foundation: permissions, roles, role_permissions, user_roles, user_permissions.
--
-- SCHEMA ONLY. This migration creates five new, currently-UNUSED tables. It seeds
-- nothing, assigns nothing, and does not touch `users`, `scope.js`, or any existing
-- authorization decision. The current role/access_level system in
-- backend/src/middleware/scope.js remains the sole authorization authority until a
-- later, separately-reviewed phase builds a resolver and cuts over to it.
--
-- Reference: docs/authorization/permission-catalogue.md (Phase 2A, approved) —
-- the 24-key permission vocabulary this schema is designed to eventually hold, and
-- the current role vocabulary (facility, state_admin, state_viewer, cluster_admin,
-- lga_admin, overall_admin) this schema is designed to eventually represent.
--
-- THE THREE-LAYER MODEL, kept structurally separate on purpose:
--   PERMISSION  — can this user perform this action at all?         (stock.write)
--   ROLE        — a named bundle of permissions.                    (state_admin)
--   SCOPE       — which rows the grant applies to.                  (own state)
-- A permission key is never suffixed with a scope ('stock.write.state' does not
-- exist). Scope is carried as separate (scope_type, scope_id) columns on the two
-- tables that assign access to a user, so the same permission vocabulary works
-- whether the grant is facility-wide, state-wide, or unscoped.
--
-- users.id IS THE IDENTITY ANCHOR. No second user table. `users` is not modified —
-- these are pure junction/definition tables that reference it by FK only.
--
-- Run manually on prod (migrations do not auto-apply here).

-- ── permissions ─────────────────────────────────────────────────────────────────
-- The permission KEY is the stable identifier — not a surrogate id. Every other
-- table in this file references permissions by `key`, never by a numeric id, so the
-- identifier that appears in application code (`can('stock.write')`) is the same
-- value stored everywhere it is referenced.
create table if not exists permissions (
  key         text primary key,
  module      text,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Enforces the naming rule the catalogue already documents (lowercase,
  -- dot-separated, machine-readable) at the one place that can actually guarantee
  -- it. Two-segment ('stock.read') and deeper ('system.diagnostics.read') keys both
  -- match; a role name, a facility name, or anything without a dot cannot be
  -- inserted as a permission key by mistake.
  constraint permissions_key_format check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

-- ── roles ────────────────────────────────────────────────────────────────────────
-- A role is only ever a named bundle of permissions (via role_permissions below).
-- No authorization logic may reference a role by name; that is exactly the pattern
-- this redesign replaces (see scope.js's READ_ADMIN_LEVELS/WRITE_ADMIN_LEVELS,
-- unchanged by this migration).
create table if not exists roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  -- Distinguishes the six roles the current access_level vocabulary will map onto
  -- (seeded in a later, separate phase) from any custom role created afterward.
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint roles_name_format check (name ~ '^[a-z][a-z0-9_]*$')
);

-- ── role_permissions ─────────────────────────────────────────────────────────────
-- Pure junction table: which permissions a role bundles. No scope column here —
-- scope belongs to the USER'S assignment (user_roles), not to the role definition
-- itself, so the same role can be granted to different users at different scopes.
create table if not exists role_permissions (
  role_id        uuid not null references roles(id) on delete cascade,
  permission_key text not null references permissions(key) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (role_id, permission_key)
);

-- ── user_roles ───────────────────────────────────────────────────────────────────
-- Assigns a role to a user, at a scope. scope_type/scope_id are free text, not an
-- enum or a FK to a lookup table: the existing scope dimensions this must eventually
-- represent (facility, state, LGA, cluster — see scope.js) are themselves plain text
-- today (facilities.state/lga/cluster have no lookup table either), and a future
-- dimension must not require a schema change here to add. No CHECK constrains the
-- values for the same reason — inventing that list now would hard-code today's
-- dimensions into the database ahead of the design that is supposed to decide them.
--
-- scope_type/scope_id are NOT NULL DEFAULT '' rather than nullable. A nullable
-- column cannot appear in a plain composite PRIMARY KEY (Postgres treats NULL as
-- "no value provided" and never treats two NULLs as duplicates), which would have
-- forced an invalid PK definition or a separate expression-based unique index just
-- to prevent duplicate assignments. Defaulting to '' for "no scope restriction"
-- keeps the primary key itself the uniqueness guarantee, and is required for the
-- role_permissions.permission_key clarity: composite PK is a normal PK the app
-- driver understands, no coalesce trick to keep in sync elsewhere.
create table if not exists user_roles (
  user_id    uuid not null references users(id) on delete cascade,
  role_id    uuid not null references roles(id) on delete cascade,
  scope_type text not null default '',
  scope_id   text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, role_id, scope_type, scope_id)
);

-- ── user_permissions ─────────────────────────────────────────────────────────────
-- Direct grants and denials, layered on top of whatever a user's roles already
-- imply. The intended FUTURE resolution rule (role permissions + direct grants -
-- direct denials, deny wins) is NOT implemented anywhere yet — no resolver exists,
-- and nothing reads this table.
--
-- effect is NOT part of the primary key: a user may hold at most ONE row per
-- (user, permission, scope), and that row's effect decides grant or deny. This is
-- deliberate, not an oversight — allowing both a grant row and a deny row for the
-- identical (user, permission, scope) would create data with no coherent meaning
-- (which one wins? by insertion order? that's not a rule, that's an accident). The
-- primary key makes that state unrepresentable rather than needing a resolver to
-- paper over it later.
create table if not exists user_permissions (
  user_id        uuid not null references users(id) on delete cascade,
  permission_key text not null references permissions(key) on delete cascade,
  effect         text not null check (effect in ('grant', 'deny')),
  scope_type     text not null default '',
  scope_id       text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, permission_key, scope_type, scope_id)
);

-- ── indexes ──────────────────────────────────────────────────────────────────────
-- Each composite primary key above already indexes its OWN leading column(s) for
-- free (the leftmost-prefix rule), so an index is added only where a lookup pattern
-- needs a column that is NOT the leading column of its table's primary key.
--
-- role_permissions's PK is (role_id, permission_key) — "which roles carry
-- permission X" cannot use that index without permission_key as an independent
-- lookup key.
create index if not exists idx_role_permissions_permission_key
  on role_permissions (permission_key);

-- user_roles's PK is (user_id, role_id, ...) — "user_id" lookups ("this user's
-- roles") are already covered by the PK itself; NOT added here (would be a
-- redundant duplicate index). "role_id" lookups ("who holds this role") are not
-- covered, since role_id is the second PK column, not the leading one.
create index if not exists idx_user_roles_role_id
  on user_roles (role_id);

-- user_permissions's PK is (user_id, permission_key, ...) — "user_id" lookups
-- ("this user's direct grants/denials") are already covered by the PK itself; NOT
-- added here. "permission_key" lookups ("who has a direct grant/denial on this
-- permission") are not covered, since permission_key is the second PK column.
create index if not exists idx_user_permissions_permission_key
  on user_permissions (permission_key);
