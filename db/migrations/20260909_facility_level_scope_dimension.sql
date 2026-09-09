-- Allow 'facility_level' as a user_role_scopes dimension.
--
-- A second, orthogonal narrowing axis for essential_admin — PHC vs Secondary —
-- alongside its existing state geography scope. See aclAdminService.js
-- (validateScopes, createUser) and scope.js (adminLevel).

alter table public.user_role_scopes
  drop constraint if exists user_role_scopes_dimension_check;

alter table public.user_role_scopes
  add constraint user_role_scopes_dimension_check
  check (dimension = any (array['geography', 'commodity', 'module', 'facility_level']));
