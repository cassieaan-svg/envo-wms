// Provision an Essential Commodities administrator.
//
//   node scripts/addEssentialAdmin.mjs <username> "<State>" [password]
//   node scripts/addEssentialAdmin.mjs ec.akwaibom "Akwa Ibom"
//
// Username is the email local-part; the login form appends "@envo.ng". Prints a
// generated password when none is given. Idempotent.
//
// WHAT THIS ACCOUNT IS. Administers Essential Commodities within one state: it
// adds items to the Essential part of the shared catalogue, and administers
// Essential Commodities users in that state. It is NOT an HIV administrator and
// cannot become one — the module scope is what stops it.
//
// NO OPERATIONAL ACCESS VIA scope.js, for the same two independent reasons as
// system_admin: 'essential_admin' appears in neither READ_ADMIN_LEVELS nor
// WRITE_ADMIN_LEVELS, and the account carries no facility_id for the
// `facilityId === scope.facilityId` fallback. admin_state is set, but that
// narrows nothing here — narrowedAdminFacilityIds only applies to
// state_admin/state_viewer/cluster_admin/lga_admin, and it is consulted only
// after isReadAdmin/isWriteAdmin has already returned true, which it never does
// for this role. Verified in aclEssentialAdmin.test.js rather than assumed.
//
// Do NOT add a facility_id or a commodity_section to this account. A facility
// would hand it real stock access through the own-facility fallback; a section
// is an HIV concept that does not apply to Essential's six categories.
//
// ITS PERMISSIONS ARE CURRENTLY A COPY OF state_admin's, which describe HIV
// facility workflows the Essential module does not have (it has priced
// requisitions, and zero rows in stock/dispense/transfer). That mismatch is known
// and deliberately deferred until the Essential module is built — see
// 20260907_acl_essential_admin_assignment.sql. The module scope is what keeps it
// harmless: those keys cannot reach HIV data.

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
  const state = (process.argv[3] || '').trim()
  if (!username || !state) {
    console.error('Usage: node scripts/addEssentialAdmin.mjs <username> "<State>" [password]')
    process.exit(1)
  }
  if (!/^[a-z0-9._-]+$/i.test(username)) {
    console.error(`Invalid username "${username}" — letters, digits, dot, dash and underscore only.`)
    process.exit(1)
  }

  // The state must be one the facility table actually knows, or the geography
  // scope would name something that matches no facility — a scope that silently
  // covers nothing.
  const { rows: known } = await pool.query(
    `select 1 from facilities where state = $1 limit 1`, [state])
  if (!known.length) {
    const { rows: all } = await pool.query(
      `select distinct state from facilities where state is not null order by 1`)
    console.error(`Unknown state "${state}". Known: ${all.map(r => r.state).join(', ')}`)
    process.exit(1)
  }

  const email = `${username}@envo.ng`
  const password = process.argv[4] || makePassword()
  const hash = await bcrypt.hash(password, 10)
  const meta = { access_level: 'essential_admin', admin_state: state, email_verified: true }

  await pool.query(
    `insert into users (id, email, encrypted_password, raw_user_meta_data)
     values (gen_random_uuid(), $1, $2, $3::jsonb)
     on conflict (email) do update
       set encrypted_password = excluded.encrypted_password,
           raw_user_meta_data = excluded.raw_user_meta_data`,
    [email, hash, JSON.stringify(meta)]
  )
  console.log(`  ✓ ${email}  (essential_admin — ${state})`)

  const result = await syncAcl()
  if (!result.synced) console.warn(`  ⚠ ACL not synced: ${result.reason}`)

  const { rows } = await pool.query(
    `select r.name role,
            (select string_agg(s.dimension || ':' || s.scope_id, ', ' order by s.dimension)
               from user_role_scopes s where s.user_id = u.id) scopes
       from users u
       left join user_roles ur on ur.user_id = u.id
       left join roles r on r.id = ur.role_id
      where u.email = $1`, [email])
  console.log(`    ACL role: ${rows[0]?.role || '(none)'} · scopes: ${rows[0]?.scopes || '(none)'}`)
  if (!/module:essential/.test(rows[0]?.scopes || '')) {
    console.warn('  ⚠ NO module scope — this account would reach every module. Apply 20260907_acl_essential_admin_assignment.sql.')
  }

  console.log(`\nUsername: ${username}`)
  if (!process.argv[4]) console.log(`Password: ${password}`)

  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
