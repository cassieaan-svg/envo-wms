-- Audit finding B-2: essential_admin must not reach the HIV module.
--
-- WHAT WENT WRONG. Phase 2M.2c gave essential_admin a second module row, `hiv`,
-- so that it could administer users and catalogue items across both programmes.
-- The module dimension ORs within itself, so {essential, hiv} reads as "opens
-- either module" — and the dimension is read by the RESOLVER, which uses it for
-- one thing only: whether a commodity is inside the account's operational reach.
--
-- The role also carries commodity sections {pharmacy, essential} (Phase 2M.2d),
-- and scope ANDs across dimensions. So:
--
--     commodity dimension   pharmacy OR essential      Pharmacy drugs -> pass
--     module dimension      essential OR hiv           Pharmacy drugs -> pass
--     => stock.write on an HIV Pharmacy drug           ALLOWED
--
-- Legacy grants this role NOTHING operationally: 'essential_admin' appears in
-- neither READ_ADMIN_LEVELS nor WRITE_ADMIN_LEVELS, and the account carries no
-- facility_id, so every facility guard in scope.js denies it. The ACL, holding a
-- byte-identical copy of state_admin's 26 keys, would have granted state-wide
-- write over another programme's stock at cutover. Measured: 42 widened
-- decisions out of 1,560 sampled, all on ec.akwaibom@envo.ng.
--
-- WHY THE MODULE ROW IS THE RIGHT THING TO REMOVE. The two capabilities 2M.2c
-- was reaching for do not read this dimension at all:
--
--   catalogue items   routes/commodities.js catalogueModulesFor() pins
--                     essential_admin to ['essential'] directly, and
--                     isCatalogueManager admits it to ?all=true regardless of
--                     scope rows. Unaffected.
--   user creation     aclAdminService actorModules() DOES read these rows, so
--                     essential_admin may now only grant `module = essential`.
--                     That is what aclEssentialAdmin.test.js already claimed
--                     under the name "it cannot write a scope outside its own
--                     module" — a test that until now passed only because its
--                     target was the actor itself and SELF_EDIT fired first.
--                     The claim is now true for the reason it always stated.
--
-- WHAT IS DELIBERATELY NOT CHANGED. The commodity sections stay {pharmacy,
-- essential} (Phase 2M.2d's confirmed shape, and the same set the 194 grantees
-- carry). `pharmacy` is inert for this role once the module row is gone — the
-- AND across dimensions blocks every HIV category — and removing it would mean
-- rewriting the section invariant that aclEssentialSection.test.js enforces for
-- both populations at once. The module row is the single guard, so it is
-- asserted directly in aclEssentialAdmin.test.js rather than left implied.
--
-- Phase 2M.2c's insert is removed at source as well, so a fresh production run
-- of the migration sequence never creates the row in the first place. This file
-- exists for databases that already have it, and is listed in
-- aclProvisioning.MIGRATIONS so every provisioning call re-asserts the boundary.
--
-- Shadow-only: scope.js is untouched. Legacy already denies this account
-- everything, so no live decision changes — this closes a CUTOVER widening.
--
-- Idempotent: deletes by a precise predicate, so re-running is a no-op.
--
-- Run manually on prod (migrations do not auto-apply here).

delete from user_role_scopes s
 using user_roles ur, roles r
 where s.user_id = ur.user_id
   and s.role_id = ur.role_id
   and r.id = ur.role_id
   and r.name = 'essential_admin'
   and s.dimension = 'module'
   and s.scope_id = 'hiv';
