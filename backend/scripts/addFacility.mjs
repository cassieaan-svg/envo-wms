// Add ONE omitted facility + its core facility logins to the Postgres users
// table (bcryptjs, same as the login path). Idempotent: the facility is inserted
// only if absent (matched by name+state), and accounts upsert by email. Each
// account gets a unique random password, written to a gitignored *_logins*.csv.
//
//   node scripts/addFacility.mjs [outfile.csv]
//
// Edit the FACILITY / PREFIX / ACCOUNTS block for a different facility.

import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { pool } from '../src/db.js'

// ── Config ──────────────────────────────────────────────────────────────────
const FACILITY = {
  name:    'Federal Medical Centre Ebute-Metta',
  code:    'FME280',            // placeholder — replace with the official HF code if you get it
  state:   'Lagos',
  lga:     'Lagos Mainland',
  cluster: 'Lagos Central',      // must match the LGA→cluster mapping
}
const PREFIX = 'fmcebutemetta'

// The 4 core logins (2 per section). username = <prefix>.<suffix>.
const ROLES = [
  { suffix: 'pharmmanager', facility_role: 'store_manager', commodity_section: 'pharmacy' },
  { suffix: 'pharmacy',     facility_role: 'dispenser',     commodity_section: 'pharmacy' },
  { suffix: 'labmanager',   facility_role: 'store_manager', commodity_section: 'lab' },
  { suffix: 'lab',          facility_role: 'dispenser',     commodity_section: 'lab' },
]
// ────────────────────────────────────────────────────────────────────────────

const OUT = process.argv[2] || 'scripts/new_facility_logins.csv'
const CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
function makePassword() {
  let pw
  do { pw = Array.from(crypto.randomBytes(12), b => CHARS[b % CHARS.length]).join('') } while (!/[2-9]/.test(pw))
  return pw
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

async function main() {
  // 1) Facility — insert only if it isn't already there (by name + state).
  let fac = (await pool.query(
    `select id from facilities where name = $1 and state = $2`, [FACILITY.name, FACILITY.state])).rows[0]
  if (fac) {
    console.log(`Facility already exists (${fac.id}) — reusing it.`)
  } else {
    fac = (await pool.query(
      `insert into facilities (id, name, code, state, lga, cluster)
       values (gen_random_uuid(), $1, $2, $3, $4, $5) returning id`,
      [FACILITY.name, FACILITY.code, FACILITY.state, FACILITY.lga, FACILITY.cluster])).rows[0]
    console.log(`Facility created: ${FACILITY.name} (${fac.id}) — ${FACILITY.state} / ${FACILITY.lga} / cluster ${FACILITY.cluster}`)
  }

  // 2) Accounts.
  const rows = [['username', 'password', 'facility_role', 'section', 'email']]
  for (const r of ROLES) {
    const email = `${PREFIX}.${r.suffix}@envo.ng`
    const password = makePassword()
    const hash = await bcrypt.hash(password, 10)
    const meta = {
      access_level: 'facility',
      facility_id: fac.id,
      facility_name: FACILITY.name,
      admin_state: FACILITY.state,
      facility_role: r.facility_role,
      commodity_section: r.commodity_section,
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
    rows.push([email.replace('@envo.ng', ''), password, r.facility_role, r.commodity_section, email])
    console.log(`  ✓ ${email}  (${r.facility_role} / ${r.commodity_section})`)
  }

  fs.writeFileSync(OUT, rows.map(r => r.map(csvCell).join(',')).join('\r\n'))
  console.log(`\nDone. ${ROLES.length} logins written to ${OUT}`)
  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
