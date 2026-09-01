// Add one DSD site login (facility_role = 'dsd') for an existing facility. The
// dsd_site_name is what a store manager selects when dispatching stock to this
// site; the login then receives that stock and records its own consumption.
// Idempotent (upsert by email); random password written to a gitignored
// *_logins*.csv. Matches the shape of the existing DSD accounts.
//
//   node scripts/addDsdAccount.mjs --facility "<hub name>" --site "<spoke name>" \
//                                  --username <login> [--type "<dsd model>"] [--out file.csv]
//
// Every flag is optional and falls back to the Config block below, so the original
// no-argument form still reproduces the NIMR account it was written for.

import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { pool } from '../src/db.js'

// ── Config (defaults; override with the flags above) ──────────────────────────
const DEFAULTS = {
  facility: 'Nigerian Institute of Medical Research (NIMR)',
  site:     'Fast Track',       // the DSD site this login represents
  type:     'Fast Track',       // the DSD model (tags this login's dispatches)
  username: 'nimr.fasttrack',
  section:  'pharmacy',         // DSD is pharmacy
  out:      'scripts/dsd_account_logins.csv',
}
// ──────────────────────────────────────────────────────────────────────────────

// --flag value pairs; anything unset falls back to DEFAULTS.
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const FACILITY_NAME = flag('facility') ?? DEFAULTS.facility
const DSD_SITE_NAME = flag('site')     ?? DEFAULTS.site
const DSD_TYPE      = flag('type')     ?? DEFAULTS.type
const USERNAME      = flag('username') ?? DEFAULTS.username
const SECTION       = flag('section')  ?? DEFAULTS.section
const DRY           = argv.includes('--dry-run')

// Positional outfile kept for the original `addDsdAccount.mjs out.csv` form.
const OUT = flag('out') ?? argv.find(a => !a.startsWith('--') && a.endsWith('.csv')) ?? DEFAULTS.out
const CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
function makePassword() {
  let pw
  do { pw = Array.from(crypto.randomBytes(12), b => CHARS[b % CHARS.length]).join('') } while (!/[2-9]/.test(pw))
  return pw
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

async function main() {
  const fac = (await pool.query(`select id, name, state from facilities where name = $1`, [FACILITY_NAME])).rows[0]
  if (!fac) throw new Error(`Facility not found: "${FACILITY_NAME}" — check the exact stored name.`)

  const email = `${USERNAME}@envo.ng`

  // Re-running is meant to reset one site's password, not to quietly repoint an
  // existing login at a different spoke — so say what is already there first.
  const existing = (await pool.query(
    `select raw_user_meta_data->>'dsd_site_name' site,
            raw_user_meta_data->>'facility_name' facility
     from users where email = $1`, [email])).rows[0]
  if (existing && existing.site !== DSD_SITE_NAME) {
    throw new Error(
      `${email} already exists for site "${existing.site}" at ${existing.facility}. ` +
      `Refusing to repoint it at "${DSD_SITE_NAME}" — pick a different --username.`)
  }

  const siblings = (await pool.query(
    `select distinct raw_user_meta_data->>'dsd_site_name' site from users
     where raw_user_meta_data->>'facility_id' = $1
       and raw_user_meta_data->>'facility_role' = 'dsd'
       and raw_user_meta_data->>'dsd_site_name' is not null
     order by 1`, [fac.id])).rows.map(r => r.site)

  if (DRY) {
    console.log(`Would ${existing ? 'UPDATE' : 'create'} DSD login "${USERNAME}"`)
    console.log(`  hub    : ${fac.name} (${fac.state})`)
    console.log(`  site   : ${DSD_SITE_NAME}`)
    console.log(`  model  : ${DSD_TYPE}`)
    console.log(`  section: ${SECTION}`)
    console.log(`  spokes already at this hub: ${siblings.join(', ') || '(none)'}`)
    await pool.end()
    return
  }

  const password = makePassword()
  const hash = await bcrypt.hash(password, 10)
  const meta = {
    facility_role: 'dsd',
    facility_id: fac.id,
    facility_name: fac.name,
    hub_facility: fac.name,
    admin_state: fac.state,
    dsd_site_name: DSD_SITE_NAME,
    dsd_type: DSD_TYPE,
    commodity_section: SECTION,
    email_verified: true,
  }
  await pool.query(
    `insert into users (id, email, encrypted_password, raw_user_meta_data)
     values (gen_random_uuid(), $1, $2, $3::jsonb)
     on conflict (email) do update
       set encrypted_password = excluded.encrypted_password,
           raw_user_meta_data = excluded.raw_user_meta_data`,
    [email, hash, JSON.stringify(meta)]
  )

  const rows = [
    ['username', 'password', 'dsd_site_name', 'section', 'facility', 'email'],
    [email.replace('@envo.ng', ''), password, DSD_SITE_NAME, SECTION, fac.name, email],
  ]
  fs.writeFileSync(OUT, rows.map(r => r.map(csvCell).join(',')).join('\r\n'))
  console.log(`Created DSD login for ${fac.name} (${fac.state}) — site "${DSD_SITE_NAME}", section ${SECTION}.`)
  console.log(`  username: ${email.replace('@envo.ng', '')}`)
  console.log(`Credentials written to: ${OUT}`)
  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
