// Seeds a WMS login. Usage:
//   node scripts/createAdminUser.mjs <username> <password> [role] [fullName]
// Role defaults to 'admin'. Re-running with an existing username updates its password.
import bcrypt from 'bcryptjs';
import pool, { query } from '../src/db.js';

const [username, password, role = 'admin', fullName = null] = process.argv.slice(2);

async function main() {
  if (!username || !password) {
    throw new Error('usage: node scripts/createAdminUser.mjs <username> <password> [role] [fullName]');
  }
  if (!['admin', 'standard'].includes(role)) {
    throw new Error(`role must be 'admin' or 'standard', got '${role}'`);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const { rows } = await query(
    `INSERT INTO users (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           full_name = COALESCE(EXCLUDED.full_name, users.full_name)
     RETURNING id, username, role`,
    [username, passwordHash, fullName, role]
  );

  const user = rows[0];
  console.log(`user #${user.id} '${user.username}' ready with role '${user.role}'`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
