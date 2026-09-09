import { query } from '../db.js';

// Resolves what a WMS user is allowed to do — permissions -> roles -> user_roles, per the
// Phase 1 authorization design. Deliberately its own layer, separate from EnVo's ACL: WMS
// has its own users table and must keep authenticating and authorizing through a Cloud
// outage, which a shared, centrally-hosted ACL service cannot promise.
//
// Fail-closed throughout: every method here defaults to "no" on anything unexpected (a
// missing user, a DB error surfacing as a thrown exception rather than a swallowed true).
export class AuthzService {
  /** The full set of permission keys a user holds, across every role they've been granted. */
  static async permissionsForUser(userId) {
    if (!userId) return new Set();
    const { rows } = await query(
      `SELECT DISTINCT rp.permission_key
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1`,
      [userId]
    );
    return new Set(rows.map((r) => r.permission_key));
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
   * The single yes/no check every route and service should call. Checks the local
   * emergency lockout first — see migration 040 — so a lockout takes effect immediately
   * regardless of what roles a stale or fresh roster says this user holds.
   */
  static async hasPermission(userId, permissionKey) {
    if (!userId || !permissionKey) return false;
    if (await AuthzService.isLocallyDisabled(userId)) return false;
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
   */
  static async recordAudit({ actorUserId = null, action, targetUserId = null, detail = null }) {
    await query(
      `INSERT INTO authz_audit_log (actor_user_id, action, target_user_id, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [actorUserId, action, targetUserId, detail ? JSON.stringify(detail) : null]
    );
  }
}
