-- Phase 2M.2c: the Essential administrator opens both modules, and every account
-- carrying the Essential grant is pinned to the pharmacy section.
--
-- ── 1. essential_admin gains the HIV module — WITHDRAWN ─────────────────────
--
-- This step used to add `module = hiv` to essential_admin, to let one
-- administrator work across both programmes. It was wrong, and the pre-production
-- audit caught it before cutover: see
-- 20260908_acl_essential_admin_module_boundary.sql for the full finding.
--
-- In short — the module dimension is read by the RESOLVER, and it means one
-- thing: which commodities are inside the account's OPERATIONAL reach. Adding
-- `hiv` to widen an administrative capability also handed the role state-wide
-- stock.write over HIV Pharmacy drugs, which legacy denies it entirely.
--
-- The capabilities this step was reaching for do not read this dimension:
-- catalogue writes are pinned by catalogueModulesFor() in routes/commodities.js,
-- and user creation is governed by actorModules(), which SHOULD narrow with the
-- role. The insert is removed rather than commented out so a fresh run of the
-- migration sequence never creates the row at all.
--
-- The asymmetry the original note claimed still holds, and now holds both ways:
-- an HIV administrator cannot reach Essential, and an Essential administrator
-- cannot reach HIV.
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

-- ── 1 ── withdrawn, see the header. No statement here by design. ─────────────

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
