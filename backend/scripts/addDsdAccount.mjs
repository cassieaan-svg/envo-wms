// Add one DSD site login (facility_role = 'dsd') for an existing facility. The
// dsd_site_name is what a store manager selects when dispatching stock to this
// site; the login then receives that stock and records its own consumption.
// Idempotent (upsert by email); random password written to a gitignored
// *_logins*.csv. Matches the shape of the existing DSD accounts.
//
//   node scripts/addDsdAccount.mjs [outfile.csv]
//
// Edit the Config block for a different site/facility.

import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { pool } from '../src/db.js'

// ── Config ────────────────────────────────────────────────────────────────────
const FACILITY_NAME = 'Nigerian Institute of Medical Research (NIMR)'
const DSD_SITE_NAME = 'Fast Track'   // the DSD site this login represents
const DSD_TYPE      = 'Fast Track'   // the DSD model (tags this login's dispatches)
const USERNAME      = 'nimr.fasttrack'
const SECTION       = 'pharmacy'      // DSD is pharmacy
// ──────────────────────────────────────────────────────────────────────────────

const OUT = process.argv[2] || 'scripts/dsd_account_logins.csv'
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
