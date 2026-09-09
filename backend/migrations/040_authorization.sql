-- Phase 1 of the WMS authorization rework: permission-first RBAC
-- (permissions -> roles -> user_roles), replacing the binary admin/standard role check.
-- See the approved Phase 1 design for the full rationale, matrix and migration reasoning.
--
-- `users.role` is left in place — login still reads/writes it, for backward compatibility
-- and as a display label — but no authorization decision consults it once the route swap
-- in this phase lands. The resolved permission set is the only source of truth from here.

CREATE TABLE permissions (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

-- facility_scope_id is a forward-compatibility hook, not enforced in Phase 1 (the audit's
-- scope section): every grant today is unscoped (NULL = unrestricted), matching the current
-- single-warehouse deployment. Enforcing it is deferred until a second warehouse exists.
CREATE TABLE user_roles (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  facility_scope_id INT REFERENCES facilities(id) ON DELETE SET NULL,
  granted_by INT REFERENCES users(id),
  granted_at TIMESTAMPTZ DEFAULT now()
);

-- A NULL facility_scope_id would otherwise make every unscoped grant distinct to a UNIQUE
-- constraint (Postgres treats NULLs as non-equal), so the "no duplicate unscoped grant"
-- rule is a partial index instead. A second, scoped grant of the same role is a later-phase
-- concern and is not constrained here.
CREATE UNIQUE INDEX user_roles_unscoped_uniq ON user_roles (user_id, role_id) WHERE facility_scope_id IS NULL;

-- Local-only emergency lockout. Deliberately absent from MasterDataService's sync payload in
-- both directions, so an incoming roster sync can never clear an emergency disable, and this
-- instance's use of it can never contend with Cloud's authoritative role/permission grants —
-- the same single-writer discipline the stock-authority model already enforces, applied here.
ALTER TABLE users ADD COLUMN is_locally_disabled BOOLEAN NOT NULL DEFAULT false;

-- Every user/role/permission change is attributed — closes the audit-logging gap the
-- Phase 1 audit identified. Append-only; nothing here is ever updated or deleted.
CREATE TABLE authz_audit_log (
  id SERIAL PRIMARY KEY,
  actor_user_id INT REFERENCES users(id),
  action TEXT NOT NULL,
  target_user_id INT REFERENCES users(id),
  detail JSONB,
  occurred_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX authz_audit_log_target_idx ON authz_audit_log (target_user_id);

-- ── Seed: the Phase 1 permission catalogue ──────────────────────────────────────────────
INSERT INTO permissions (key, description) VALUES
  ('batches.create', 'Create a commodity batch (intake/receiving)'),
  ('batches.editNumber', 'Correct a batch''s recorded batch number'),
  ('batches.adjust', 'Adjust a batch''s stock (cycle count / ad hoc correction)'),
  ('batches.view', 'Read batch and stock data'),
  ('requests.view', 'Read inbound facility requests'),
  ('requests.fulfil', 'Mark a request as picking, fulfil it, or reject it'),
  ('requests.receipt', 'Record a facility receipt (chain of custody)'),
  ('dispatchOrders.view', 'Read dispatch orders'),
  ('dispatchOrders.edit', 'Edit an already-dispatched order, or create one directly for a facility'),
  ('dispatchOrders.print', 'Print or reprint a dispatch order waybill'),
  ('facilities.view', 'Read the facility list/detail'),
  ('facilities.manage', 'Create, edit, or deactivate facilities'),
  ('facilities.assignCommodities', 'Assign or remove a facility''s commodity list'),
  ('commodities.manage', 'Create or edit commodities'),
  ('commodities.setStockLevels', 'Set a commodity''s reorder/max stock levels'),
  ('commodities.setPrices', 'Set a commodity''s current price'),
  ('vendors.manage', 'Create, edit, or deactivate vendors'),
  ('reconciliation.view', 'Read reconciliation findings and anomalies, and run the check'),
  ('reconciliation.run', 'Run the reconciliation check and record findings'),
  ('reconciliation.resolve', 'Resolve a reconciliation finding'),
  ('accounts.view', 'Read debtors, outstanding/settled orders and payment history'),
  ('accounts.recordPayment', 'Record a payment against a dispatch order'),
  ('monitoring.view', 'Read the activity log / monitoring dashboards'),
  ('sync.view', 'Read sync/outbox status'),
  ('sync.forceRun', 'Manually trigger or retry sync/outbox delivery'),
  ('instance.configure', 'Change instance-level configuration (WMS_ROLE, sync tokens, thresholds)'),
  ('users.create', 'Create a WMS user login'),
  ('users.disable', 'Disable a WMS user login, including the local emergency lockout'),
  ('roles.assignOperational', 'Assign the Picker/Dispatcher or Receiving Clerk role to a user'),
  ('roles.assignAny', 'Assign any role, including System Administrator and Warehouse Admin'),
  ('permissions.manage', 'Define or edit permission keys'),
  ('roles.manage', 'Create or edit roles'),
  ('rolePermissions.manage', 'Edit which permissions a role bundle contains');

-- ── Seed: the four Phase 1 roles ────────────────────────────────────────────────────────
INSERT INTO roles (key, label) VALUES
  ('system_administrator', 'System Administrator'),
  ('warehouse_admin', 'Warehouse Admin'),
  ('picker_dispatcher', 'Picker/Dispatcher'),
  ('receiving_clerk', 'Receiving Clerk');

-- System Administrator: identity/permission architecture and instance config only —
-- deliberately NO operational permissions (batches, requests, dispatch, facilities, ...).
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM roles WHERE key = 'system_administrator'), k FROM unnest(ARRAY[
  'monitoring.view', 'sync.view', 'sync.forceRun', 'instance.configure',
  'users.create', 'users.disable', 'roles.assignOperational', 'roles.assignAny',
  'permissions.manage', 'roles.manage', 'rolePermissions.manage'
]) AS k;

-- Warehouse Admin: full operational authority, plus user creation/disable and assigning
-- OPERATIONAL roles only — cannot touch the permission architecture or hand out
-- System Administrator / Warehouse Admin.
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM roles WHERE key = 'warehouse_admin'), k FROM unnest(ARRAY[
  'batches.create', 'batches.editNumber', 'batches.adjust', 'batches.view',
  'requests.view', 'requests.fulfil', 'requests.receipt',
  'dispatchOrders.view', 'dispatchOrders.edit', 'dispatchOrders.print',
  'facilities.view', 'facilities.manage', 'facilities.assignCommodities',
  'commodities.manage', 'commodities.setStockLevels', 'commodities.setPrices',
  'vendors.manage',
  'reconciliation.view', 'reconciliation.run', 'reconciliation.resolve',
  'accounts.view', 'accounts.recordPayment',
  'monitoring.view', 'sync.view',
  'users.create', 'users.disable', 'roles.assignOperational'
]) AS k;

INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM roles WHERE key = 'picker_dispatcher'), k FROM unnest(ARRAY[
  'batches.view', 'requests.view', 'requests.fulfil', 'requests.receipt',
  'dispatchOrders.view', 'dispatchOrders.print', 'facilities.view'
]) AS k;

INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM roles WHERE key = 'receiving_clerk'), k FROM unnest(ARRAY[
  'batches.create', 'batches.editNumber', 'batches.view', 'facilities.view'
]) AS k;

-- ── Migrate the two existing accounts, if present in this database ─────────────────────
-- cms.admin's entire demonstrated history is operational-admin action (everything behind
-- the old requireAdmin gate). Nothing implies permission-architecture or instance-config
-- authority, so it becomes Warehouse Admin only — not System Administrator, which nothing
-- in its usage justifies granting. See the Phase 1 audit, section 7.
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, (SELECT id FROM roles WHERE key = 'warehouse_admin')
FROM users u WHERE u.username = 'cms.admin'
ON CONFLICT DO NOTHING;

-- cms.viewer's real historical scope — reads plus the four previously-unguarded actions
-- (fulfil/reject/receipt/print) — maps exactly onto Picker/Dispatcher. It never had
-- batch/facility/vendor/reconciliation/payment writes; those were always requireAdmin-gated.
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, (SELECT id FROM roles WHERE key = 'picker_dispatcher')
FROM users u WHERE u.username = 'cms.viewer'
ON CONFLICT DO NOTHING;

-- No existing account is migrated to System Administrator: nothing in the audit justifies
-- assuming either current account should hold it. Run scripts/createSystemAdministrator.mjs
-- to mint one deliberately, with a password you choose.
--
-- Note for the Cloud <-> CMS sync path: on first sync, Cloud's authoritative user_roles
-- rows supersede whatever this migration seeded locally (MasterDataService.apply replaces
-- user_roles wholesale from the incoming snapshot). The inserts above exist purely so a
-- freshly-migrated CMS instance is not locked out of its own two seed accounts before its
-- first successful sync — an offline-safe bootstrap default, not a competing writer.
