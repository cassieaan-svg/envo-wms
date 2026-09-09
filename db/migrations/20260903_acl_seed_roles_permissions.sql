-- Phase 2C: seed the approved 24 permissions, 6 system roles, and their
-- role_permissions mappings into the ACL tables Phase 2B created.
--
-- DATA ONLY. This migration seeds definitions and role→permission MAPPINGS. It
-- does not touch `user_roles` or `user_permissions` — no user is assigned anything.
-- The current role/access_level system in scope.js remains the sole authorization
-- authority; nothing reads these tables yet, so this migration cannot change any
-- authorization decision by construction, not just by care.
--
-- Source: docs/authorization/permission-catalogue.md (Phase 2A, approved) and its
-- Section 3 role→permission mapping, made exhaustive here rather than illustrative.
--
-- Idempotent: `on conflict do nothing` throughout, so re-running never duplicates
-- or errors — matches the `if not exists` idiom Phase 2B's own migration used for
-- the same reason.
--
-- Run manually on prod (migrations do not auto-apply here) — though this migration
-- targets the LOCAL development database only for now; nothing here assigns a
-- production user anything, so applying it changes no live behavior anywhere it
-- runs.

-- ── permissions (24) ─────────────────────────────────────────────────────────────
-- module groups match the catalogue's own section headings, not an invented
-- taxonomy. 'reporting' covers report/activity/bincard, exactly as the catalogue
-- grouped them under one heading ("Reporting / Activity / Bincard").
insert into permissions (key, module, description) values
  ('stock.read',              'stock',         'Read facility stock (store/dispensary bins and lot ledger)'),
  ('stock.write',             'stock',         'Write facility stock, including lot edits'),
  ('dsd_stock.read',          'dsd_stock',     'Read DSD (community spoke) site stock'),
  ('dsd_stock.write',         'dsd_stock',     'Write DSD site stock'),
  ('sdp_stock.read',          'sdp_stock',     'Read SDP (service point) stock'),
  ('sdp_stock.write',         'sdp_stock',     'Write SDP stock'),
  ('transfer.read',           'transfer',      'Read stock transfers'),
  ('transfer.write',          'transfer',      'Create and transition a transfer (dispatch, assign, accept, dispute, cancel, approve, receive, update, delete — one capability, see catalogue Section 5)'),
  ('dispense_log.read',       'dispense_log',  'Read dispense records'),
  ('dispense_log.write',      'dispense_log',  'Record a dispense'),
  ('intake_log.read',         'intake_log',    'Read intake records'),
  ('intake_log.write',        'intake_log',    'Record an intake'),
  ('adjustment_log.read',     'adjustment_log','Read stock adjustment records'),
  ('adjustment_log.write',    'adjustment_log','Record a stock adjustment'),
  ('amc_settings.read',       'amc_settings',  'Read AMC month-selection settings'),
  ('amc_settings.write',      'amc_settings',  'Write AMC month-selection settings'),
  ('edit_history.read',       'edit_history',  'Read the audit trail (currently unscoped — see catalogue Section 6)'),
  ('edit_history.write',      'edit_history',  'Append to the audit trail (currently unscoped — see catalogue Section 6)'),
  ('commodity.read',          'commodity',     'Read the commodity catalogue (public today — no write capability exists)'),
  ('facility.read',           'facility',      'Read the facility list (public today — no write capability exists)'),
  ('report.read',             'reporting',     'Read daily/weekly/monthly/stock-balance reports and CSV export'),
  ('activity.read',           'reporting',     'Read the activity feed'),
  ('bincard.read',            'reporting',     'Read the bin card / stock-take view'),
  ('system.diagnostics.read', 'diagnostics',   'Read raw SQL pool diagnostics (dev-only, ENVO_DIAG=1)')
on conflict (key) do nothing;

-- ── roles (6) ────────────────────────────────────────────────────────────────────
-- Exactly the approved vocabulary from Phase 2A.1 — no hq_tools, no facility_role,
-- no catch-all. All six are system roles: they represent access levels the current
-- runtime already has, not new custom roles created via this migration.
insert into roles (name, description, is_system) values
  ('facility',      'Own facility, read/write, section-pinned. The default access level.', true),
  ('state_admin',   'Own state; the only cross-facility writer today (stock, dsd_stock, sdp_stock, amc_settings, transfer). Both sections.', true),
  ('state_viewer',  'Own state, read-only, both sections.', true),
  ('cluster_admin', 'Own cluster, read-only, section-pinned.', true),
  ('lga_admin',     'Own LGA, read-only, section-pinned.', true),
  ('overall_admin', 'National, read-only on everything, by deliberate design never writes.', true)
on conflict (name) do nothing;

-- ── role_permissions (107 mappings) ─────────────────────────────────────────────
-- Derived directly from permission-catalogue.md Section 3, made exhaustive.
-- `system.diagnostics.read` is assigned to exactly the five roles that satisfy
-- isAdminScope() in the current code (scope.js:244-247) — overall_admin,
-- state_admin, state_viewer, cluster_admin, lga_admin — and withheld from
-- `facility`, which does not.
with wanted (role_name, permission_key) as (
  values
    -- facility: everything except system.diagnostics.read (23 keys)
    ('facility', 'stock.read'),          ('facility', 'stock.write'),
    ('facility', 'dsd_stock.read'),      ('facility', 'dsd_stock.write'),
    ('facility', 'sdp_stock.read'),      ('facility', 'sdp_stock.write'),
    ('facility', 'transfer.read'),       ('facility', 'transfer.write'),
    ('facility', 'dispense_log.read'),   ('facility', 'dispense_log.write'),
    ('facility', 'intake_log.read'),     ('facility', 'intake_log.write'),
    ('facility', 'adjustment_log.read'), ('facility', 'adjustment_log.write'),
    ('facility', 'amc_settings.read'),   ('facility', 'amc_settings.write'),
    ('facility', 'edit_history.read'),   ('facility', 'edit_history.write'),
    ('facility', 'commodity.read'),
    ('facility', 'facility.read'),
    ('facility', 'report.read'),
    ('facility', 'activity.read'),
    ('facility', 'bincard.read'),

    -- state_admin: all 24 (full read+write set, plus diagnostics)
    ('state_admin', 'stock.read'),          ('state_admin', 'stock.write'),
    ('state_admin', 'dsd_stock.read'),      ('state_admin', 'dsd_stock.write'),
    ('state_admin', 'sdp_stock.read'),      ('state_admin', 'sdp_stock.write'),
    ('state_admin', 'transfer.read'),       ('state_admin', 'transfer.write'),
    ('state_admin', 'dispense_log.read'),   ('state_admin', 'dispense_log.write'),
    ('state_admin', 'intake_log.read'),     ('state_admin', 'intake_log.write'),
    ('state_admin', 'adjustment_log.read'), ('state_admin', 'adjustment_log.write'),
    ('state_admin', 'amc_settings.read'),   ('state_admin', 'amc_settings.write'),
    ('state_admin', 'edit_history.read'),   ('state_admin', 'edit_history.write'),
    ('state_admin', 'commodity.read'),
    ('state_admin', 'facility.read'),
    ('state_admin', 'report.read'),
    ('state_admin', 'activity.read'),
    ('state_admin', 'bincard.read'),
    ('state_admin', 'system.diagnostics.read'),

    -- state_viewer: every *.read key, plus diagnostics (15)
    ('state_viewer', 'stock.read'),
    ('state_viewer', 'dsd_stock.read'),
    ('state_viewer', 'sdp_stock.read'),
    ('state_viewer', 'transfer.read'),
    ('state_viewer', 'dispense_log.read'),
    ('state_viewer', 'intake_log.read'),
    ('state_viewer', 'adjustment_log.read'),
    ('state_viewer', 'amc_settings.read'),
    ('state_viewer', 'edit_history.read'),
    ('state_viewer', 'commodity.read'),
    ('state_viewer', 'facility.read'),
    ('state_viewer', 'report.read'),
    ('state_viewer', 'activity.read'),
    ('state_viewer', 'bincard.read'),
    ('state_viewer', 'system.diagnostics.read'),

    -- cluster_admin: identical read-only set to state_viewer (15)
    ('cluster_admin', 'stock.read'),
    ('cluster_admin', 'dsd_stock.read'),
    ('cluster_admin', 'sdp_stock.read'),
    ('cluster_admin', 'transfer.read'),
    ('cluster_admin', 'dispense_log.read'),
    ('cluster_admin', 'intake_log.read'),
    ('cluster_admin', 'adjustment_log.read'),
    ('cluster_admin', 'amc_settings.read'),
    ('cluster_admin', 'edit_history.read'),
    ('cluster_admin', 'commodity.read'),
    ('cluster_admin', 'facility.read'),
    ('cluster_admin', 'report.read'),
    ('cluster_admin', 'activity.read'),
    ('cluster_admin', 'bincard.read'),
    ('cluster_admin', 'system.diagnostics.read'),

    -- lga_admin: identical read-only set (15)
    ('lga_admin', 'stock.read'),
    ('lga_admin', 'dsd_stock.read'),
    ('lga_admin', 'sdp_stock.read'),
    ('lga_admin', 'transfer.read'),
    ('lga_admin', 'dispense_log.read'),
    ('lga_admin', 'intake_log.read'),
    ('lga_admin', 'adjustment_log.read'),
    ('lga_admin', 'amc_settings.read'),
    ('lga_admin', 'edit_history.read'),
    ('lga_admin', 'commodity.read'),
    ('lga_admin', 'facility.read'),
    ('lga_admin', 'report.read'),
    ('lga_admin', 'activity.read'),
    ('lga_admin', 'bincard.read'),
    ('lga_admin', 'system.diagnostics.read'),

    -- overall_admin: identical read-only set (15) — deliberately never a writer
    ('overall_admin', 'stock.read'),
    ('overall_admin', 'dsd_stock.read'),
    ('overall_admin', 'sdp_stock.read'),
    ('overall_admin', 'transfer.read'),
    ('overall_admin', 'dispense_log.read'),
    ('overall_admin', 'intake_log.read'),
    ('overall_admin', 'adjustment_log.read'),
    ('overall_admin', 'amc_settings.read'),
    ('overall_admin', 'edit_history.read'),
    ('overall_admin', 'commodity.read'),
    ('overall_admin', 'facility.read'),
    ('overall_admin', 'report.read'),
    ('overall_admin', 'activity.read'),
    ('overall_admin', 'bincard.read'),
    ('overall_admin', 'system.diagnostics.read')
)
insert into role_permissions (role_id, permission_key)
select r.id, w.permission_key
  from wanted w
  join roles r on r.name = w.role_name
on conflict (role_id, permission_key) do nothing;
