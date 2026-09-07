// Provision a system administrator — the account that administers users, roles
// and scopes, and nothing else.
//
//   node scripts/addSystemAdmin.mjs <username> [password]
//   node scripts/addSystemAdmin.mjs sysadmin
//
// Username is the email local-part; the login form appends "@envo.ng" (house
// style, see the account-provisioning notes). Prints a generated password when
// none is given. Idempotent: re-running resets the password and metadata.
//
// WHAT THIS ACCOUNT CAN DO. Exactly three ACL permissions — user.read,
// user.write, user_permission.write — and no operational access whatsoever.
// That is not enforced by a special case; it falls out of the existing model:
//
//   * 'system_admin' appears in neither READ_ADMIN_LEVELS nor
//     WRITE_ADMIN_LEVELS in scope.js, so no per-table admin tier grants it
//     anything;
//   * the account is deliberately given NO facility_id, so the
//     `facilityId === scope.facilityId` fallback in every facility guard fails
//     for every real facility.
//
// Two independent reasons, both already in place. Do NOT add a facility_id,
// commodity_section or admin_state to this account to make a screen render —
// each of those would hand it real data access. aclSystemAdmin.test.js asserts
// the denial table and will fail if one is added.
//
// It DOES read the three tables whose policy is literally 'public' in
// READ_ADMIN_LEVELS — commodities, facilities, amc_settings — exactly like every
// other authenticated account. That is how the admin UI lists facilities, and it
// exposes nothing a state_viewer cannot already read.

import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { pool } from '../src/db.js'
import { syncAcl } from '../src/services/aclProvisioning.js'

const CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
const makePassword = () => {
  let pw
  do { pw = Array.from(crypto.randomBytes(12), b => CHARS[b % CHARS.length]).join('') } while (!/[2-9]/.test(pw))
  return pw
}

async function main() {
  const username = (process.argv[2] || '').trim().replace(/@envo\.ng$/i, '')
  if (!username) {
    console.error('Usage: node scripts/addSystemAdmin.mjs <username> [password]')
    process.exit(1)
  }
  if (!/^[a-z0-9._-]+$/i.test(username)) {
    console.error(`Invalid username "${username}" — letters, digits, dot, dash and underscore only.`)
    process.exit(1)
  }

  const email = `${username}@envo.ng`
  const password = process.argv[3] || makePassword()
  const hash = await bcrypt.hash(password, 10)

  // No facility_id, no commodity_section, no admin_state — see the header.
  const meta = { access_level: 'system_admin', email_verified: true }

  await pool.query(
    `insert into users (id, email, encrypted_password, raw_user_meta_data)
     values (gen_random_uuid(), $1, $2, $3::jsonb)
     on conflict (email) do update
       set encrypted_password = excluded.encrypted_password,
           raw_user_meta_data = excluded.raw_user_meta_data`,
    [email, hash, JSON.stringify(meta)]
  )
  console.log(`  ✓ ${email}  (system_admin — user administration only)`)

  // Assigns the ACL role and, by exclusion, NO scope rows in any dimension.
  const result = await syncAcl()
  if (!result.synced) console.warn(`  ⚠ ACL not synced: ${result.reason}`)

  const { rows } = await pool.query(
    `select r.name role,
            (select count(*)::int from user_role_scopes s where s.user_id = u.id) scopes
       from users u
       left join user_roles ur on ur.user_id = u.id
       left join roles r on r.id = ur.role_id
      where u.email = $1`, [email])
  console.log(`    ACL role: ${rows[0]?.role || '(none)'} · scope rows: ${rows[0]?.scopes ?? 0} (national/unscoped by design)`)

  console.log(`\nUsername: ${username}`)
  if (!process.argv[3]) console.log(`Password: ${password}`)

  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
