// Deliberately manual, deliberately separate from createAdminUser.mjs and from migration
// 040. The Phase 1 audit found nothing in either existing account's usage that justified
// assuming it should hold System Administrator, so that role is never assigned
// automatically — this script exists so the decision is made on purpose, by you, with a
// password you choose, not inherited by a migration guessing on your behalf.
//
// Usage:
//   node scripts/createSystemAdministrator.mjs <username> <password> [fullName]
//
// Re-running with an existing username updates its password and (re-)grants the role —
// it does not touch any other role the account may already hold.
import bcrypt from 'bcryptjs';
import pool, { query } from '../src/db.js';
import { AuthzService } from '../src/services/authzService.js';

const [username, password, fullName = null] = process.argv.slice(2);

async function main() {
  if (!username || !password) {
    throw new Error('usage: node scripts/createSystemAdministrator.mjs <username> <password> [fullName]');
  }
  if (password.length < 8) {
    throw new Error('password must be at least 8 characters');
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const { rows } = await query(
    `INSERT INTO users (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, 'standard')
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           full_name = COALESCE(EXCLUDED.full_name, users.full_name)
     RETURNING id, username`,
    [username, passwordHash, fullName]
  );
  const user = rows[0];

  const { rows: roleRows } = await query("SELECT id FROM roles WHERE key = 'system_administrator'");
  if (!roleRows[0]) {
    throw new Error("role 'system_administrator' not found — has migration 040 been applied?");
  }

  await query(
    `INSERT INTO user_roles (user_id, role_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, role_id) WHERE facility_scope_id IS NULL DO NOTHING`,
    [user.id, roleRows[0].id]
  );

  // Self-attributed: this is the one legitimate case of a user granting themselves a role,
  // because it happens outside the running application, by whoever holds database access —
  // not through the roles.assignAny route, which refuses self-targeting unconditionally.
  await AuthzService.recordAudit({
    actorUserId: user.id,
    action: 'role.grant',
    targetUserId: user.id,
    detail: { role: 'system_administrator', via: 'createSystemAdministrator.mjs (manual bootstrap)' },
  });

  console.log(`user #${user.id} '${user.username}' is now System Administrator`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
