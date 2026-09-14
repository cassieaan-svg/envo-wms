import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db.js';
import { AuthzService } from './authzService.js';

// User/role administration — the piece the Phase 1 audit found entirely missing (accounts
// were seeded directly in the database). Every write here is attributed via
// AuthzService.recordAudit, closing that gap.

const OPERATIONAL_ROLES = new Set(['picker_dispatcher', 'receiving_clerk']);
const PRIVILEGED_ROLES = new Set(['system_administrator', 'warehouse_admin']);

export class AdminUsersService {
  /** 'operational' | 'privileged' | null (unknown role key). Decides which assign permission a
   *  role grant/revoke needs — roles.assignOperational vs roles.assignAny. */
  static roleTier(roleKey) {
    if (OPERATIONAL_ROLES.has(roleKey)) return 'operational';
    if (PRIVILEGED_ROLES.has(roleKey)) return 'privileged';
    return null;
  }

  static async listUsers() {
    const { rows } = await query(
      `SELECT u.id, u.username, u.full_name, u.is_active, u.is_locally_disabled,
              COALESCE(
                json_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '[]'
              ) AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
        GROUP BY u.id
        ORDER BY u.username`
    );
    return rows;
  }

  static async listRoles() {
    const { rows } = await query(
      `SELECT r.id, r.key, r.label,
              COALESCE(json_agg(rp.permission_key ORDER BY rp.permission_key)
                       FILTER (WHERE rp.permission_key IS NOT NULL), '[]') AS permissions
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
        GROUP BY r.id
        ORDER BY r.key`
    );
    return rows;
  }

  static async createUser({ username, password, fullName, actorUserId }) {
    if (!username?.trim()) { const e = new Error('username is required'); e.status = 400; throw e; }
    if (!password || password.length < 8) {
      const e = new Error('password must be at least 8 characters'); e.status = 400; throw e;
    }
    const hash = await bcrypt.hash(password, 10);
    let rows;
    try {
      ({ rows } = await query(
        // Kept 'standard' on the legacy role column for compatibility; the new user has no
        // permissions at all until a role is granted below or in a follow-up call.
        `INSERT INTO users (username, password_hash, full_name, role)
         VALUES ($1, $2, $3, 'standard')
         RETURNING id, username, full_name, is_active`,
        [username.trim(), hash, fullName?.trim() || null]
      ));
    } catch (err) {
      if (err.code === '23505') { const e = new Error('that username is already taken'); e.status = 409; throw e; }
      throw err;
    }
    const user = rows[0];
    await AuthzService.recordAudit({
      actorUserId, action: 'user.create', targetUserId: user.id, detail: { username: user.username },
    });
    return user;
  }

  static async disableUser(id, { actorUserId }) {
    const { rows } = await query(
      'UPDATE users SET is_active = false WHERE id = $1 RETURNING id, username, is_active', [id]
    );
    if (!rows[0]) { const e = new Error('user not found'); e.status = 404; throw e; }
    await AuthzService.recordAudit({ actorUserId, action: 'user.disable', targetUserId: id });
    return rows[0];
  }

  static async enableUser(id, { actorUserId }) {
    const { rows } = await query(
      'UPDATE users SET is_active = true WHERE id = $1 RETURNING id, username, is_active', [id]
    );
    if (!rows[0]) { const e = new Error('user not found'); e.status = 404; throw e; }
    await AuthzService.recordAudit({ actorUserId, action: 'user.enable', targetUserId: id });
    return rows[0];
  }

  /**
   * The local emergency lockout (migration 040). Deliberately separate from disableUser:
   * this flag is local-only, never synced in either direction, and is checked on every
   * request ahead of any permission resolution (see middleware/auth.js) — so it can lock
   * someone out immediately even when this instance cannot reach Cloud.
   */
  static async setLocalDisabled(id, disabled, { actorUserId }) {
    const { rows } = await query(
      'UPDATE users SET is_locally_disabled = $2 WHERE id = $1 RETURNING id, username, is_locally_disabled',
      [id, Boolean(disabled)]
    );
    if (!rows[0]) { const e = new Error('user not found'); e.status = 404; throw e; }
    await AuthzService.recordAudit({
      actorUserId, action: disabled ? 'user.localDisable' : 'user.localEnable', targetUserId: id,
    });
    return rows[0];
  }

  /**
   * Grant a role. Self-targeting is refused outright, unconditionally — an administrator
   * must never be the one who widens their own access, so a second administrator (System
   * Administrator for a privileged role, either for an operational one) has to act instead.
   * The caller is expected to have already checked the tier-appropriate permission.
   */
  static async grantRole(userId, roleKey, { actorUserId }) {
    if (Number(userId) === Number(actorUserId)) {
      const e = new Error('you cannot change your own roles'); e.status = 403; throw e;
    }
    const { rows: roleRows } = await query('SELECT id FROM roles WHERE key = $1', [roleKey]);
    if (!roleRows[0]) { const e = new Error('unknown role'); e.status = 400; throw e; }

    const { rows } = await query(
      `INSERT INTO user_roles (user_id, role_id, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, role_id) WHERE facility_scope_id IS NULL DO NOTHING
       RETURNING id, user_id, role_id`,
      [userId, roleRows[0].id, actorUserId]
    );
    await AuthzService.recordAudit({
      actorUserId, action: 'role.grant', targetUserId: userId, detail: { role: roleKey },
    });
    return rows[0] || null;
  }

  static async revokeRole(userId, roleKey, { actorUserId }) {
    if (Number(userId) === Number(actorUserId)) {
      const e = new Error('you cannot change your own roles'); e.status = 403; throw e;
    }
    const { rows } = await query(
      `DELETE FROM user_roles ur USING roles r
        WHERE ur.role_id = r.id AND r.key = $2 AND ur.user_id = $1
        RETURNING ur.id`,
      [userId, roleKey]
    );
    await AuthzService.recordAudit({
      actorUserId, action: 'role.revoke', targetUserId: userId, detail: { role: roleKey },
    });
    return rows[0] || null;
  }

  // Permissions that are otherwise exclusive to a privileged role (system_administrator) in
  // the seeded matrix, plus two with real financial/stock blast radius — granting any of
  // these to someone individually is functionally close to a promotion, or moves money/stock
  // outside the usual flow. Used only to flag `detail.sensitive` on the audit row; the UI
  // uses the same list to show its confirmation warning. Not an access control — access is
  // already fully decided by requiring permissions.manage in the first place (see
  // routes/adminUsers.js); this is a "make it hard to miss," not a "make it impossible".
  static SENSITIVE_PERMISSIONS = new Set([
    'permissions.manage',
    'roles.manage',
    'rolePermissions.manage',
    'roles.assignAny',
    'instance.configure',
    'batches.adjust',
    'accounts.recordPayment',
  ]);

  /** The full per-permission breakdown for the "Manage permissions" screen. */
  static async getUserPermissions(userId) {
    return AuthzService.effectivePermissionDetails(userId);
  }

  /**
   * Grant or deny a permission directly to a user, independent of their roles. Self-targeting
   * is refused unconditionally, exactly like grantRole/revokeRole — the caller is expected to
   * have already checked permissions.manage (the route does this; see AdminUsersService's own
   * role-grant methods for the same division of labour).
   *
   * The override write and its audit row commit in one transaction — either both happen or
   * neither does. `previousEffect` is read under the same transaction so a concurrent write
   * to the same (user, permission) can't be reported inaccurately: whichever call commits
   * second sees the first call's result as `previousEffect`, not a stale pre-transaction read.
   */
  static async setPermissionOverride(userId, permissionKey, effect, { actorUserId }) {
    if (Number(userId) === Number(actorUserId)) {
      const e = new Error('you cannot change your own permissions'); e.status = 403; throw e;
    }
    if (effect !== 'grant' && effect !== 'deny') {
      const e = new Error("effect must be 'grant' or 'deny'"); e.status = 400; throw e;
    }

    return withTransaction(async (client) => {
      const { rows: permRows } = await client.query('SELECT 1 FROM permissions WHERE key = $1', [permissionKey]);
      if (!permRows[0]) { const e = new Error('unknown permission'); e.status = 400; throw e; }

      // Row-locked so a concurrent grant/deny on the same (user, permission) serialises
      // rather than racing to two conflicting upserts — the UNIQUE constraint would stop a
      // duplicate row either way, but the lock is what makes `previousEffect` trustworthy.
      const { rows: existing } = await client.query(
        `SELECT effect FROM user_permission_overrides
          WHERE user_id = $1 AND permission_key = $2 FOR UPDATE`,
        [userId, permissionKey]
      );
      const previousEffect = existing[0]?.effect ?? null;

      const { rows } = await client.query(
        `INSERT INTO user_permission_overrides (user_id, permission_key, effect, granted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, permission_key) DO UPDATE SET effect = EXCLUDED.effect,
           granted_by = EXCLUDED.granted_by, granted_at = now()
         RETURNING id, user_id, permission_key, effect, granted_at`,
        [userId, permissionKey, effect, actorUserId]
      );

      await AuthzService.recordAudit({
        actorUserId,
        action: effect === 'grant' ? 'permission.override.grant' : 'permission.override.deny',
        targetUserId: userId,
        detail: {
          permission: permissionKey,
          previousEffect,
          newEffect: effect,
          sensitive: AdminUsersService.SENSITIVE_PERMISSIONS.has(permissionKey),
        },
        client,
      });

      return rows[0];
    });
  }

  /**
   * Remove a direct override, restoring whatever the user's roles alone would produce.
   * Idempotent: removing an override that doesn't exist is a successful no-op — it writes
   * NO audit row, because nothing actually changed and a row claiming otherwise would
   * mislead anyone reading the trail later.
   */
  static async removePermissionOverride(userId, permissionKey, { actorUserId }) {
    if (Number(userId) === Number(actorUserId)) {
      const e = new Error('you cannot change your own permissions'); e.status = 403; throw e;
    }

    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `DELETE FROM user_permission_overrides
          WHERE user_id = $1 AND permission_key = $2
          RETURNING effect`,
        [userId, permissionKey]
      );
      if (!rows[0]) return { removed: false };

      await AuthzService.recordAudit({
        actorUserId,
        action: 'permission.override.remove',
        targetUserId: userId,
        detail: { permission: permissionKey, previousEffect: rows[0].effect, newEffect: null },
        client,
      });

      return { removed: true };
    });
  }
}
