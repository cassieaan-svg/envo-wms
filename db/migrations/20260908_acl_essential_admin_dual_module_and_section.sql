-- Phase 2M.2c: the Essential administrator opens both modules, and every account
-- carrying the Essential grant is pinned to the pharmacy section.
--
-- ── 1. essential_admin gains the HIV module ─────────────────────────────────
--
-- Phase 2M.2 confined essential_admin to `module = essential`, which was the
-- right fix for the defect it closed (an ABSENT module row meant unconstrained).
-- The confirmed requirement is different: an Essential administrator opens BOTH
-- modules, the same way the 194 dual-module store-manager logins do.
--
-- The dimension ORs within itself, so two rows read as "opens hiv or essential".
-- This WIDENS essential_admin's commodity reach to HIV items — deliberately, and
-- it is the one direction in this migration that is not a narrowing.
--
-- Note this does NOT make the reverse true: an HIV administrator still holds only
-- `module = hiv` and is still refused Essential commodities by the ACL. The
-- asymmetry is the point.
--
-- ── 2. The Essential grant implies the pharmacy section ─────────────────────
--
-- 162 of the 194 granted logins already carry `commodity_section = 'pharmacy'`;
-- 32 (31 lga_admin + 1 state_admin) carry none, and NO section row means
-- unconstrained — so those 32 see every section, which is wider than the 162
-- doing the same job.
--
-- pharmacy is not an arbitrary choice: the essential-commodities branch requires
-- that section as a precondition for opening Essential at all ("on top of
-- facility enrolment and the pharmacy section"), which is exactly why the 162
-- have it. This brings the other 32 into line.
--
-- ACL ONLY. scope.js is untouched, so these 32 accounts keep seeing every section
-- live until cutover — attachScope gives state_admin/overall_admin bothSections
-- regardless. Deliberately not addressed here; closing it live is a separate
-- decision about attachScope that has not been taken.
--
-- Idempotent. Run manually on prod (migrations do not auto-apply here). The
-- granted accounts exist only locally today.

-- ── 1 ────────────────────────────────────────────────────────────────────────
insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
select ur.user_id, ur.role_id, 'module', 'module', 'hiv'
  from user_roles ur
  join roles r on r.id = ur.role_id
 where r.name = 'essential_admin'
   and not exists (
     select 1 from user_role_scopes s
      where s.user_id = ur.user_id and s.role_id = ur.role_id
        and s.dimension = 'module' and s.scope_id = 'hiv')
on conflict do nothing;

-- ── 2 ────────────────────────────────────────────────────────────────────────
-- Keyed on the grant, not on the email pattern or the access level: the grant is
-- the fact that makes the pharmacy section a precondition.
insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
select ur.user_id, ur.role_id, 'commodity', 'section', 'pharmacy'
  from user_roles ur
  join users u on u.id = ur.user_id
 where (u.raw_user_meta_data->>'essential')::boolean is true
   and not exists (
     select 1 from user_role_scopes s
      where s.user_id = ur.user_id and s.role_id = ur.role_id
        and s.dimension = 'commodity' and s.scope_type = 'section')
on conflict do nothing;
