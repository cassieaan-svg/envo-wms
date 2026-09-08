-- Phase 2M.2b: dual-module logins carry a module row per module.
--
-- THE DEFECT THIS CLOSES. 20260907_acl_module_dimension.sql gave every existing
-- account `module = hiv`, on the stated assumption that "every account that
-- exists today was provisioned for the HIV programme". That assumption was
-- wrong.
--
-- 194 accounts are named <slug>.essential@envo.ng and carry `essential: true` in
-- raw_user_meta_data. They come from the essential-commodities branch, whose own
-- commit describes them exactly:
--
--     "Opening Essential now needs an explicit per-login grant (meta.essential)
--      on top of facility enrolment and the pharmacy section … A provisioning
--      script mints a separate <slug>.essential store-manager login per enrolled
--      facility that carries the grant and OPENS BOTH MODULES."
--
-- So they are DUAL-MODULE logins, not Essential-only ones, and two readings were
-- both wrong:
--
--   module = hiv only        silently drops the Essential half of the grant
--   module = essential only  drops the HIV half — and because their
--                            commodity_section is 'pharmacy' (an HIV section)
--                            and scope ANDs across dimensions, it leaves them
--                            able to see NOTHING AT ALL. Measured, not guessed.
--
-- Their `commodity_section = 'pharmacy'` is deliberate, not a provisioning slip:
-- that branch requires the pharmacy section as a precondition for Essential
-- access. It is left untouched here.
--
-- THE FIX. Add a SECOND module row. The commodity/module dimension ORs within
-- itself, so `module = hiv` OR `module = essential` is precisely "this login
-- opens both" — no new mechanism, because meta.essential is a grant and the
-- module dimension is what already expresses grants.
--
-- Keyed on `raw_user_meta_data ? 'essential'` rather than on the email pattern:
-- the grant is the fact, the naming convention is only how it is spelled today.
--
-- Shadow-only: scope.js is untouched. The essential-commodities branch enforces
-- meta.essential live via its own scope.js change; this is the ACL's
-- representation of the same grant, and the two agree.
--
-- Idempotent. Run manually on prod (migrations do not auto-apply here) — though
-- these 194 accounts exist only locally today; the production dump has none of
-- them.

insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
select ur.user_id, ur.role_id, 'module', 'module', 'essential'
  from user_roles ur
  join users u on u.id = ur.user_id
 where (u.raw_user_meta_data->>'essential')::boolean is true
   and not exists (
     select 1 from user_role_scopes s
      where s.user_id = ur.user_id and s.role_id = ur.role_id
        and s.dimension = 'module' and s.scope_id = 'essential')
on conflict do nothing;
