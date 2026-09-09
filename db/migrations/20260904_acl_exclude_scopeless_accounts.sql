-- Exclude accounts that cannot carry a meaningful ACL scope.
--
-- Phase 2D migrated every user whose access_level was one of the six approved
-- values, or absent (which attachScope defaults to 'facility'). One account came
-- through that filter with a facility role but NO facility to scope it to,
-- because its raw_user_meta_data carries no facility_id at all:
--
--   cassieaan@gmail.com  ->  role=facility, scope_type=facility, scope_id=''
--
-- An empty scope_id is the most restrictive value the model has — it matches no
-- facility, so the row grants nothing. It is still better removed than kept: a
-- role assignment that can never authorise anything is noise in every audit, and
-- an empty scope is exactly the shape a future bug could misread as "unscoped
-- therefore unrestricted". Excluding it makes the invariant clean: every row in
-- user_roles has a scope that identifies something real (overall_admin's
-- deliberately empty scope excepted, which means national by design).
--
-- hq.tools@envo.ng is already excluded — Phase 2D never assigned it a role,
-- because 'hq_tools' is not one of the six approved access levels and no code on
-- main gives it any meaning. Nothing to do for it here; named only so the set of
-- deliberately role-less accounts is documented in one place.
--
-- NOT DELETED: both user rows themselves, their credentials, and their
-- raw_user_meta_data are untouched. Both accounts still authenticate exactly as
-- before. Only the ACL role assignment is removed, and the ACL is not yet
-- authoritative for anything.
--
-- Idempotent: deletes by a precise predicate, so re-running is a no-op.
--
-- Run manually on prod (migrations do not auto-apply here).

delete from user_roles ur
 using users u, roles r
 where ur.user_id = u.id
   and ur.role_id = r.id
   and r.name = 'facility'
   and ur.scope_type = 'facility'
   and ur.scope_id = ''
   and coalesce(u.raw_user_meta_data->>'facility_id', '') = '';
