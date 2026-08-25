// Grant (or revoke) Essential Commodities oversight on an EXISTING admin login.
//
// Essential is gated on a per-login `essential: true` grant. That gate now applies to
// admin tiers as well as facilities (see enforceModuleAccess in middleware/scope.js) —
// before, every state/LGA/cluster admin could reach Essential endpoints without ever
// being granted the module. So an admin who should oversee Essential needs the flag
// adding here; everyone else stays HIV-only.
//
// Admin access is OVERSIGHT-ONLY: the flag opens the read views (Warehouse Requests,
// Stock, Monitoring, Activity Log) scoped to the admin's own state/LGA/cluster. It
// grants no writes — the backend refuses those regardless of this flag.
//
// This edits accounts in place rather than creating new ones, and takes the accounts
// EXPLICITLY. There is deliberately no "grant every admin" switch: the whole point of
// the gate is that it is opt-in per login.
//
//   node scripts/grantEssentialAdmins.mjs                      # list admins + status
//   node scripts/grantEssentialAdmins.mjs --grant  akwaibom.state uyo.lga
//   node scripts/grantEssentialAdmins.mjs --revoke akwaibom.state
//
// A bare username is resolved to <username>@envo.ng; a full e-mail works too.
// Idempotent: granting an already-granted login reports "unchanged".

import { pool } from '../src/db.js'

// The tiers that can hold Essential oversight. 'facility' is excluded on purpose —
// facility logins are granted by addEssentialStoreManagers.mjs, which also has to
// enrol the facility itself in facility_modules.
const ADMIN_LEVELS = ['overall_admin', 'state_admin', 'state_viewer', 'cluster_admin', 'lga_admin']

const toEmail = (s) => (s.includes('@') ? s : `${s}@envo.ng`).toLowerCase()

async function listAdmins() {
  const { rows } = await pool.query(
    `select email,
            raw_user_meta_data->>'access_level'      as level,
            raw_user_meta_data->>'admin_state'       as state,
            raw_user_meta_data->>'admin_lga'         as lga,
            raw_user_meta_data->>'admin_cluster'     as cluster,
            coalesce((raw_user_meta_data->>'essential')::boolean, false) as essential
       from users
      where raw_user_meta_data->>'access_level' = any($1)
      order by raw_user_meta_data->>'access_level', email`, [ADMIN_LEVELS])
  return rows
}

async function setGrant(emails, value) {
  let changed = 0, unchanged = 0
  const missing = []
  for (const email of emails) {
    const { rows } = await pool.query(
      `select raw_user_meta_data->>'access_level' as level,
              coalesce((raw_user_meta_data->>'essential')::boolean, false) as essential
         from users where lower(email) = $1`, [email])
    if (!rows.length) { missing.push(email); continue }
    const { level, essential } = rows[0]
    if (!ADMIN_LEVELS.includes(level)) {
      // Refuse rather than silently widen: a facility login granted here would get the
      // flag without its facility being enrolled in facility_modules, and would then be
      // shown a module card that every endpoint refuses.
      console.log(`  SKIP    ${email} — access_level '${level}' is not an admin tier`)
      continue
    }
    if (essential === value) { console.log(`  unchanged ${email} (already ${value ? 'granted' : 'not granted'})`); unchanged += 1; continue }

    // jsonb_set writes the flag without disturbing the rest of the metadata (facility,
    // state, section). Revoking DELETES the key rather than writing false, so the row
    // matches an account that never had the grant.
    await pool.query(
      value
        ? `update users set raw_user_meta_data = jsonb_set(coalesce(raw_user_meta_data,'{}'::jsonb), '{essential}', 'true'::jsonb, true) where lower(email) = $1`
        : `update users set raw_user_meta_data = coalesce(raw_user_meta_data,'{}'::jsonb) - 'essential' where lower(email) = $1`,
      [email])
    console.log(`  ${value ? 'GRANTED' : 'REVOKED'} ${email} (${level})`)
    changed += 1
  }
  if (missing.length) console.log(`\n  NOT FOUND: ${missing.join(', ')}`)
  console.log(`\n${changed} changed, ${unchanged} unchanged${missing.length ? `, ${missing.length} not found` : ''}`)
  // A login carries its metadata in its JWT, so a change only reaches a user who is
  // already signed in once they log in again.
  if (changed) console.log('Affected users must sign out and back in — the grant travels in the JWT.')
}

async function main() {
  const argv = process.argv.slice(2)
  const mode = argv[0] === '--grant' ? true : argv[0] === '--revoke' ? false : null

  if (mode === null) {
    if (argv.length) { console.error(`Unknown option '${argv[0]}'. Use --grant or --revoke.`); process.exit(2) }
    const rows = await listAdmins()
    console.log(`Admin logins: ${rows.length}\n`)
    for (const r of rows) {
      const area = r.state || r.lga || r.cluster || '—'
      console.log(`  ${r.essential ? '[essential]' : '[   hiv   ]'}  ${r.email.padEnd(38)} ${String(r.level).padEnd(14)} ${area}`)
    }
    console.log(`\nGranted: ${rows.filter(r => r.essential).length} of ${rows.length}`)
    console.log('Grant with:  node scripts/grantEssentialAdmins.mjs --grant <username> [...]')
    return
  }

  const targets = argv.slice(1).map(toEmail)
  if (!targets.length) { console.error('Name at least one login.'); process.exit(2) }
  console.log(`${mode ? 'Granting' : 'Revoking'} Essential oversight on ${targets.length} login(s):\n`)
  await setGrant(targets, mode)
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => pool.end())
