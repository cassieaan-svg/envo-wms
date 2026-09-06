// Bring the ACL tables up to date with public.users.
//
// THE GAP THIS CLOSES. Phase 2D was a point-in-time backfill. None of the nine
// provisioning scripts writes a user_roles row, so every account created since
// has had no ACL identity — and at cutover those users would be denied
// everything. Editing all nine would not fix the root cause either: the tenth
// script would forget again.
//
// HOW. The three backfill migrations are already idempotent — `on conflict do
// nothing` throughout, and the exclusion is a delete with a precise predicate.
// Re-running them therefore picks up exactly the users that are missing, and
// nothing else. This script re-runs them in order rather than reimplementing
// the derivation, so there is no second copy of the rules to drift out of sync
// with the first.
//
// SAFE TO RUN ANY TIME, AND ON A DATABASE WITHOUT THE ACL TABLES. Production
// does not have them yet, and these same provisioning scripts run there — so
// this exits cleanly rather than failing when the tables are absent. That is
// what makes it safe to call from a provisioning script today, before cutover.
//
//   node scripts/sync_acl.mjs           # sync, then report
//   node scripts/sync_acl.mjs --check   # report only, change nothing (exit 1 if drift)
//
// --check is the cutover gate: "every account has an ACL role" is measurable by
// running it and looking at the exit code.

import { pool, query, withTransaction } from '../src/db.js'
import fs from 'node:fs'
import path from 'node:path'

const MIGRATIONS = [
  '20260903_acl_seed_user_roles.sql',
  '20260904_acl_exclude_scopeless_accounts.sql',
  '20260905_acl_user_role_scopes.sql',
]

const DIR = path.resolve('../db/migrations')
const checkOnly = process.argv.includes('--check')

// Users that SHOULD hold an ACL role but do not. Mirrors the eligibility rules
// the backfill itself applies: one of the six approved access levels (or an
// absent one, which attachScope defaults to 'facility'), and — for a
// facility-shaped role — an actual facility to be scoped to.
const MISSING_SQL = `
  select u.id, u.email
    from users u
   where not exists (select 1 from user_roles ur where ur.user_id = u.id)
     and coalesce(nullif(u.raw_user_meta_data->>'access_level', ''), 'facility')
         in ('facility','state_admin','state_viewer','cluster_admin','lga_admin','overall_admin')
     and (coalesce(u.raw_user_meta_data->>'access_level', 'facility') <> 'facility'
          or coalesce(u.raw_user_meta_data->>'facility_id', '') <> '')
   order by u.email`

async function aclTablesExist() {
  const { rows } = await query(
    `select count(*)::int n from information_schema.tables
      where table_schema = 'public'
        and table_name in ('roles','user_roles','user_role_scopes')`)
  return rows[0].n === 3
}

try {
  if (!(await aclTablesExist())) {
    console.log('ACL tables are not present in this database — nothing to sync.')
    console.log('(Expected before the ACL migrations are applied. Not an error.)')
    process.exit(0)
  }

  const before = (await query(MISSING_SQL)).rows

  if (checkOnly) {
    if (before.length === 0) {
      console.log('✓ every eligible account holds an ACL role')
      process.exit(0)
    }
    console.error(`✗ ${before.length} eligible account(s) hold no ACL role:\n`)
    for (const u of before.slice(0, 20)) console.error(`    ${u.email}`)
    if (before.length > 20) console.error(`    … and ${before.length - 20} more`)
    console.error('\nRun without --check to fix.')
    process.exit(1)
  }

  if (before.length) {
    console.log(`${before.length} account(s) missing an ACL role:`)
    for (const u of before.slice(0, 10)) console.log(`    ${u.email}`)
    if (before.length > 10) console.log(`    … and ${before.length - 10} more`)
    console.log('')
  }

  for (const name of MIGRATIONS) {
    const file = path.join(DIR, name)
    if (!fs.existsSync(file)) throw new Error(`missing migration ${name} — run from backend/`)
    await withTransaction(async exec => { await exec(fs.readFileSync(file, 'utf8')) })
    console.log(`  applied ${name}`)
  }

  const after = (await query(MISSING_SQL)).rows
  const counts = await query(`
    select (select count(*)::int from user_roles)        roles,
           (select count(*)::int from user_role_scopes)  scopes`)

  console.log(`\nuser_roles: ${counts.rows[0].roles} · user_role_scopes: ${counts.rows[0].scopes}`)
  if (after.length === 0) {
    console.log('✓ every eligible account now holds an ACL role')
  } else {
    // Not thrown: an account can be legitimately ineligible (an unrecognised
    // access_level such as hq_tools, which is deliberately never assigned a
    // role). Anything appearing here is worth a look rather than a crash.
    console.warn(`\n⚠ ${after.length} account(s) still without a role — inspect these:`)
    for (const u of after) console.warn(`    ${u.email}`)
  }
} catch (err) {
  console.error('sync failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
