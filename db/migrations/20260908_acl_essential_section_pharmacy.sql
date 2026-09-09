-- Phase 2M.2d: every Essential account carries exactly the sections
-- {pharmacy, essential} — no more, no fewer.
--
-- WHO COUNTS AS AN ESSENTIAL ACCOUNT. Two independent markers, because the
-- population has two shapes:
--
--   raw_user_meta_data.essential = true    the per-login grant minted by the
--                                          essential-commodities branch (194
--                                          dual-module store-manager logins)
--   role = essential_admin                 the administrator role (Phase 2M.2)
--
-- Keyed on both, not on the '%.essential@envo.ng' naming convention: the grant
-- and the role are the facts, the email spelling is only how they are written
-- today.
--
-- WHY TWO SECTIONS, NOT ONE. `pharmacy` is the essential-commodities branch's
-- own precondition for opening Essential ("on top of facility enrolment and the
-- pharmacy section"), and 194 of the 195 already carried it. But a section pin
-- ANDs with the module dimension, and no section used to contain an Essential
-- category — so pinning pharmacy alone made Essential items UNREACHABLE for the
-- very accounts that exist to handle them:
--
--     essential_admin   ESSENTIAL item      false   commodity outside scope
--                       HIV Pharmacy drugs  true
--
-- `essential` is now a declared section covering that module's six categories
-- (constants/sections.js). Section rows OR within the commodity dimension, so
-- {pharmacy, essential} reads as "HIV pharmacy items, plus Essential items" —
-- which is what these accounts actually do.
--
-- EXACTLY THIS SET, AND NEVER EMPTY. Three hazards, all closed here:
--
--   * a MISSING section row means UNCONSTRAINED, not empty — the account would
--     see every section, including lab;
--   * a section outside the set (lab, general) would admit it somewhere it has
--     no business;
--   * section rows OR together, so a stray extra row silently WIDENS rather
--     than conflicting.
--
-- The delete runs FIRST so the insert cannot collide with a wrong row, and both
-- are scoped to scope_type = 'section' — category and commodity grants are a
-- different mechanism and are left alone.
--
-- NOTHING ELSE IS TOUCHED. Non-Essential accounts are excluded by the predicate,
-- and no geography or module row is read or written here.
--
-- ACL ONLY: scope.js is untouched. Adding the `essential` section key is
-- provably live-safe — no account carries that value in
-- raw_user_meta_data.commodity_section, so categoriesForSection resolves it for
-- nobody until an ACL scope row names it.
--
-- Idempotent, and re-run by syncAcl on every provisioning call so NEW Essential
-- accounts are pinned without anyone editing them by hand.

-- ── 1. Remove any section scope outside the allowed set ─────────────────────
delete from user_role_scopes s
 using users u, user_roles ur, roles r
 where s.user_id = u.id
   and ur.user_id = u.id and r.id = ur.role_id
   and ((u.raw_user_meta_data->>'essential')::boolean is true or r.name = 'essential_admin')
   and s.dimension = 'commodity'
   and s.scope_type = 'section'
   and s.scope_id not in ('pharmacy', 'essential');

-- ── 2. Ensure both sections are present ─────────────────────────────────────
insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
select ur.user_id, ur.role_id, 'commodity', 'section', want.section
  from user_roles ur
  join users u on u.id = ur.user_id
  join roles r on r.id = ur.role_id
  cross join (values ('pharmacy'), ('essential')) as want(section)
 where ((u.raw_user_meta_data->>'essential')::boolean is true or r.name = 'essential_admin')
   and not exists (
     select 1 from user_role_scopes s
      where s.user_id = ur.user_id and s.role_id = ur.role_id
        and s.dimension = 'commodity' and s.scope_type = 'section'
        and s.scope_id = want.section)
on conflict do nothing;
