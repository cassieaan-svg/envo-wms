import { query, withTransaction } from '../db.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Give newly provisioned users their ACL role and scope rows.
//
// Provisioning scripts create rows in `users` and nothing else. Before this,
// every account created after the Phase 2D backfill had no ACL identity at all —
// harmless while scope.js is authoritative, but at cutover those users would be
// denied everything.
//
// This re-runs the three backfill migrations, which are idempotent by
// construction (`on conflict do nothing`, plus a delete with a precise
// predicate). Re-running picks up exactly the users that are missing rows and
// touches nothing else. Deliberately NOT a second implementation of the
// derivation rules — one copy, no drift.
//
// SAFE WHERE THE ACL TABLES DO NOT EXIST. Production has not had the ACL
// migrations applied, and these provisioning scripts run there. This returns
// quietly in that case rather than failing, so a provisioning script can call it
// today and it simply starts working once the tables land.
//
// Never throws: a provisioning run that has already created the user must not be
// failed by a bookkeeping step. Problems are reported and the caller continues —
// `node scripts/sync_acl.mjs --check` is the gate that catches anything missed.

const MIGRATIONS = [
  '20260903_acl_seed_user_roles.sql',
  '20260904_acl_exclude_scopeless_accounts.sql',
  '20260905_acl_user_role_scopes.sql',
]

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations')

async function aclTablesExist() {
  const { rows } = await query(
    `select count(*)::int n from information_schema.tables
      where table_schema = 'public'
        and table_name in ('roles','user_roles','user_role_scopes')`)
  return rows[0].n === 3
}

/**
 * Sync the ACL tables with public.users.
 * @returns {Promise<{synced: boolean, reason?: string, assigned?: number}>}
 */
export async function syncAcl({ quiet = false } = {}) {
  try {
    if (!(await aclTablesExist())) {
      return { synced: false, reason: 'acl tables not present' }
    }

    const missingSql = `
      select count(*)::int n from users u
       where not exists (select 1 from user_roles ur where ur.user_id = u.id)
         and coalesce(nullif(u.raw_user_meta_data->>'access_level', ''), 'facility')
             in ('facility','state_admin','state_viewer','cluster_admin','lga_admin','overall_admin')
         and (coalesce(u.raw_user_meta_data->>'access_level', 'facility') <> 'facility'
              or coalesce(u.raw_user_meta_data->>'facility_id', '') <> '')`

    const before = (await query(missingSql)).rows[0].n
    if (before === 0) return { synced: true, assigned: 0 }

    const sql = MIGRATIONS.map(name => {
      const file = path.join(MIGRATIONS_DIR, name)
      if (!fs.existsSync(file)) throw new Error(`missing migration ${name}`)
      return fs.readFileSync(file, 'utf8')
    })

    // ALL THREE RUN IN ONE TRANSACTION. Separately, the seed re-creates a role
    // for an account the exclusion then removes — an account with no facility to
    // be scoped to gets a row, and loses it a moment later. Between those two
    // transactions the account visibly holds a role it is not entitled to.
    // Harmless while nothing reads these tables, but it is exactly the kind of
    // transient state a resolver would eventually act on. One transaction means
    // that window never exists outside it.
    //
    // Retried once: each statement selects across the whole users table, so an
    // account deleted mid-run — another provisioning run, an admin removing a
    // user — fails the foreign key and rolls the transaction back, assigning
    // nobody. The work is idempotent, so a second pass simply sees the account
    // already gone. Once only: a second consecutive collision means something
    // other than ordinary concurrency.
    const runAll = () => withTransaction(async exec => {
      for (const s of sql) await exec(s)
    })
    try {
      await runAll()
    } catch {
      await runAll()
    }

    const after = (await query(missingSql)).rows[0].n
    const assigned = before - after
    if (!quiet && assigned > 0) console.log(`  ✓ ACL: assigned a role to ${assigned} account(s)`)
    if (after > 0 && !quiet) console.warn(`  ⚠ ACL: ${after} account(s) still without a role`)
    return { synced: true, assigned }
  } catch (err) {
    // Bookkeeping must never fail a provisioning run that already succeeded.
    if (!quiet) console.warn(`  ⚠ ACL sync skipped: ${err.message}`)
    return { synced: false, reason: err.message }
  }
}
