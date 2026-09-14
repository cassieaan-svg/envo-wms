import { query } from '../db.js';

// Resolves what a WMS user is allowed to do — permissions -> roles -> user_roles, per the
// Phase 1 authorization design. Deliberately its own layer, separate from EnVo's ACL: WMS
// has its own users table and must keep authenticating and authorizing through a Cloud
// outage, which a shared, centrally-hosted ACL service cannot promise.
//
// Fail-closed throughout: every method here defaults to "no" on anything unexpected (a
// missing user, a DB error surfacing as a thrown exception rather than a swallowed true).
export class AuthzService {
  /**
   * The full set of permission keys a user effectively holds — the role union with direct
   * overrides applied on top (a deny removes a key the roles would otherwise grant; a grant
   * adds one they wouldn't otherwise have). Same precedence as hasPermission(), computed as
   * a set rather than a single lookup because this drives /api/auth/me — the frontend's one
   * source of truth for what to show in the nav and inside pages.
   */
  static async permissionsForUser(userId) {
    if (!userId) return new Set();
    const { rows } = await query(
      `SELECT DISTINCT rp.permission_key
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1`,
      [userId]
    );
    const granted = new Set(rows.map((r) => r.permission_key));

    const { rows: overrides } = await query(
      'SELECT permission_key, effect FROM user_permission_overrides WHERE user_id = $1',
      [userId]
    );
    for (const o of overrides) {
      if (o.effect === 'deny') granted.delete(o.permission_key);
      else granted.add(o.permission_key);
    }
    return granted;
  }

  /** The roles a user holds, for display and for the role-tier checks in AdminUsersService. */
  static async rolesForUser(userId) {
    const { rows } = await query(
      `SELECT r.id, r.key, r.label, ur.facility_scope_id
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1
        ORDER BY r.key`,
      [userId]
    );
    return rows;
  }

  static async isLocallyDisabled(userId) {
    const { rows } = await query('SELECT is_locally_disabled FROM users WHERE id = $1', [userId]);
    return rows[0]?.is_locally_disabled === true;
  }

  /**
   * The single yes/no check every route and service should call.
   *
   * Precedence, highest first:
   *   1. Local instance disable — unconditional refusal, ahead of everything else.
   *   2. Direct user DENY (user_permission_overrides) — wins even over a role that grants it.
   *   3. Direct user GRANT — wins even over a role that doesn't grant it.
   *   4. The role union (role_permissions via user_roles) — the normal, unchanged case.
   *   5. Default: not granted.
   *
   * Roles gain no deny semantics here — role_permissions stays purely additive, exactly as
   * before. The override table is a second, narrower layer in front of it, not a rewrite of
   * it. See docs/AUTHORIZATION.md and the individual-permission-overrides design report.
   */
  static async hasPermission(userId, permissionKey) {
    if (!userId || !permissionKey) return false;
    if (await AuthzService.isLocallyDisabled(userId)) return false;

    const { rows: overrideRows } = await query(
      'SELECT effect FROM user_permission_overrides WHERE user_id = $1 AND permission_key = $2',
      [userId, permissionKey]
    );
    if (overrideRows[0]) return overrideRows[0].effect === 'grant';

    const { rows } = await query(
      `SELECT 1
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1 AND rp.permission_key = $2
        LIMIT 1`,
      [userId, permissionKey]
    );
    return rows.length > 0;
  }

  /**
   * The full per-permission breakdown for the "Manage permissions" screen: every catalogue
   * key, whether a role grants it (and which one, for display), whether a direct override
   * exists, and the resolved effective state — the same precedence hasPermission() uses,
   * just computed for every key at once instead of a single yes/no.
   */
  static async effectivePermissionDetails(userId) {
    const { rows: perms } = await query('SELECT key, description FROM permissions ORDER BY key');

    const { rows: roleGrants } = await query(
      `SELECT DISTINCT rp.permission_key, r.label AS role_label
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1
        ORDER BY r.label`,
      [userId]
    );
    // A permission can come from more than one role; the first (alphabetically, per the
    // ORDER BY above) is shown as the source — good enough for "which role gives me this",
    // and avoids a second UI concept for "granted by several roles at once".
    const roleByPermission = new Map();
    for (const r of roleGrants) {
      if (!roleByPermission.has(r.permission_key)) roleByPermission.set(r.permission_key, r.role_label);
    }

    const { rows: overrides } = await query(
      'SELECT permission_key, effect FROM user_permission_overrides WHERE user_id = $1',
      [userId]
    );
    const overrideByPermission = new Map(overrides.map((o) => [o.permission_key, o.effect]));

    return perms.map((p) => {
      const roleLabel = roleByPermission.get(p.key) || null;
      const override = overrideByPermission.get(p.key) || null;
      const roleGranted = roleLabel != null;
      const effective = override ? override === 'grant' : roleGranted;
      const source = override === 'deny' ? 'override-deny'
        : override === 'grant' ? 'override-grant'
        : roleGranted ? 'role'
        : 'none';
      return {
        key: p.key,
        description: p.description,
        roleGranted,
        roleLabel,
        overrideEffect: override, // 'grant' | 'deny' | null
        effective,
        source,
      };
    });
  }

  /** Throws a 403 rather than returning a boolean, for use inside services (not just routes) —
   *  the audit's "enforce at the service layer too" recommendation. */
  static async assertPermission(userId, permissionKey) {
    if (!(await AuthzService.hasPermission(userId, permissionKey))) {
      const err = new Error(`permission required: ${permissionKey}`);
      err.status = 403;
      err.code = 'PERMISSION_REQUIRED';
      throw err;
    }
  }

  /**
   * Every user/role/permission change is attributed — actor and timestamp — closing the
   * audit-logging gap the Phase 1 audit identified. Append-only.
   *
   * Pass `client` (a transaction client) when the audit row must commit atomically with the
   * change it describes — the permission-override writes do this; role grant/revoke do not
   * yet (a pre-existing gap, not widened here, not fixed here either — out of this phase's
   * scope, called out in the design report as a nearby improvement worth making later).
   */
  static async recordAudit({ actorUserId = null, action, targetUserId = null, detail = null, client = null }) {
    const run = client ? (t, p) => client.query(t, p) : query;
    await run(
      `INSERT INTO authz_audit_log (actor_user_id, action, target_user_id, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [actorUserId, action, targetUserId, detail ? JSON.stringify(detail) : null]
    );
  }
}
