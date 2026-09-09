-- Phase 2H: feature configuration — the original business requirement.
--
--   "If a feature is available in the system and you want to turn it off for a
--    department — for example, Pharmacy — you shouldn't have to go through the
--    codebase. It should just be a configuration."
--
-- This is a DISABLE, not a DENY. A deny says "this user is not trusted to
-- transfer"; a disable says "the transfer workflow does not exist here". They
-- differ in who they apply to (everyone in the department, whatever their role),
-- how they are reversed (one row, not N permission grants), and how they read in
-- an audit. See docs/authorization/authorization-model.md §7.
--
-- DENY-ONLY. This table can switch a workflow OFF. It can never grant a
-- capability a role does not already hold — the resolver consults it solely to
-- suppress, never as a source of permission. That is what keeps configuration
-- from becoming a privilege-escalation surface, and it is asserted by test
-- (aclFeatureConfig.test.js, "configuration can never grant").
--
-- ABSENT ROW = ENABLED. The table starts empty and every existing workflow must
-- keep working, so a missing row cannot mean "off". This is not inheritance; it
-- is the direct consequence of deny-only. Stated explicitly because a missing
-- row must never be read as ambiguous.
--
-- NO WILDCARDS, NO INHERITANCE. Scope is exactly (facility, department). A
-- statewide toggle would therefore need one row per facility (~160 for Akwa
-- Ibom). That trade-off was accepted deliberately: disabling is expected to be
-- rare and genuinely per-facility. If a statewide toggle is ever actually
-- requested, the minimal extension is a nullable facility_id meaning "all
-- facilities", with most-specific-wins — deliberately NOT built speculatively.
--
-- SEEDS NOTHING. An empty table means every feature is enabled everywhere,
-- which is exactly today's behavior. Nothing reads this table in the request
-- path; scope.js remains authoritative.
--
-- Run manually on prod (migrations do not auto-apply here). Local development
-- only for now.

create table if not exists feature_config (
  facility_id uuid not null references facilities(id) on delete cascade,
  -- The department this applies to: 'pharmacy', 'lab', … Matches the vocabulary
  -- used by commodity scope's `section` scope_type (user_role_scopes) and by
  -- users.raw_user_meta_data.commodity_section. Deliberately plain text, not a
  -- FK: there is no departments table yet, and inventing one to hold two bare
  -- strings would add a join without adding meaning (authorization-model.md §16).
  department  text not null,
  -- A coarse workflow name, NOT a permission key. Declared in code
  -- (src/constants/features.js) so a typo cannot silently create a feature that
  -- nothing enforces — the same discipline permissions use. The CHECK here only
  -- constrains the shape; membership is enforced by the registry and its test.
  feature     text not null,
  enabled     boolean not null default true,
  updated_by  uuid references users(id),
  updated_at  timestamptz not null default now(),
  primary key (facility_id, department, feature),
  constraint feature_config_feature_format check (feature ~ '^[a-z][a-z0-9_]*$'),
  constraint feature_config_department_format check (department ~ '^[a-z][a-z0-9_]*$')
);

-- "Which facilities have this feature disabled" — the admin-screen read. The
-- primary key already covers facility-first lookups.
create index if not exists idx_feature_config_feature
  on feature_config (feature, enabled);
