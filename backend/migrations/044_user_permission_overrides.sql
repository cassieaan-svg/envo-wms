-- Individual user permission overrides — the exception layer sitting above role-derived
-- access. Normal access stays user -> role -> role_permissions, unchanged; this adds a
-- second, narrower path: user -> direct override, for the rare case a specific person needs
-- a specific permission granted or denied independent of whatever role they hold.
--
-- Absence of a row IS "no override" — there is no stored null/none state. This keeps the
-- table's size proportional to actual exceptions, and keeps "remove the override" a plain
-- DELETE rather than an UPDATE to a meaningless middle value.
--
-- No scope column, deliberately: the Phase 2 scope audit found no genuine scope dimension
-- in this WMS (not facility, not module, not geography, not commodity/category), and the
-- resolver this sits in front of (AuthzService.hasPermission) has never taken one either. An
-- override applies to that permission key globally, exactly as a role-derived grant already
-- does — this is consistency with the existing resolver, not a limitation introduced here.
--
-- See docs/AUTHORIZATION.md and the individual-permission-overrides design report for the
-- full precedence rationale: local disable, then direct deny, then direct grant, then the
-- existing role union, then default-deny. Roles gain no deny semantics — role_permissions
-- stays purely additive, unchanged.

CREATE TABLE user_permission_overrides (
  id             SERIAL PRIMARY KEY,
  user_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  effect         TEXT NOT NULL CHECK (effect IN ('grant', 'deny')),
  granted_by     INT REFERENCES users(id),
  granted_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, permission_key)
);

CREATE INDEX user_permission_overrides_user_idx ON user_permission_overrides (user_id);
