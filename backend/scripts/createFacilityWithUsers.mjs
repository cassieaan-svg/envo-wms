import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import fs from 'node:fs'

// Configure the new facility and its users here.
// Edit the FACILITY and USERS arrays before running.
const FACILITY = {
  name: 'New Example Facility',
  code: 'NEF-001',
  state: 'Example State',
  lga: 'Example LGA',
  cluster: 'Example Cluster',
}

// USERS: each entry must provide email and password. `username` is optional;
// if omitted the script will print the email (ready to copy from console output).
const USERS = [
  { suffix: 'pharmmanager', email: 'newfacility.pharmmanager@envo.ng', password: 'ChangeMe123!', facility_role: 'store_manager', commodity_section: 'pharmacy' },
  { suffix: 'pharmacy',     email: 'newfacility.pharmacy@envo.ng',    password: 'ChangeMe123!', facility_role: 'dispenser',     commodity_section: 'pharmacy' },
  { suffix: 'labmanager',   email: 'newfacility.labmanager@envo.ng',  password: 'ChangeMe123!', facility_role: 'store_manager', commodity_section: 'lab' },
  { suffix: 'lab',          email: 'newfacility.lab@envo.ng',         password: 'ChangeMe123!', facility_role: 'dispenser',     commodity_section: 'lab' },
]

const pool = new pg.Pool({
  host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
})

function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

async function main() {
  // 1) Facility — insert only if it isn't already there (by name + state).
  let fac = (await pool.query('select id from facilities where name = $1 and state = $2', [FACILITY.name, FACILITY.state])).rows[0]
  if (fac) {
    console.log(`Facility already exists (${fac.id}) — reusing it.`)
  } else {
    fac = (await pool.query(
      `insert into facilities (id, name, code, state, lga, cluster)
       values (gen_random_uuid(), $1, $2, $3, $4, $5) returning id`,
      [FACILITY.name, FACILITY.code, FACILITY.state, FACILITY.lga, FACILITY.cluster])).rows[0]
    console.log(`Facility created: ${FACILITY.name} (${fac.id}) — ${FACILITY.state} / ${FACILITY.lga} / cluster ${FACILITY.cluster}`)

    // Enroll the newly created facility into default modules (hiv + essential).
    try {
      await pool.query(`insert into facility_modules (facility_id, module) values ($1, 'hiv') on conflict do nothing`, [fac.id])
      await pool.query(`insert into facility_modules (facility_id, module) values ($1, 'essential') on conflict do nothing`, [fac.id])
      console.log(`  • enrolled facility ${fac.id} in modules: hiv, essential`)
    } catch (err) {
      console.error(`  • failed to enroll facility modules for ${fac.id}:`, err.message)
    }
  }

  // 2) Accounts for this facility.
  const rows = [['username', 'password', 'facility_role', 'section', 'email']]
  for (const u of USERS) {
    const email = u.email
    const password = u.password
    const hash = await bcrypt.hash(password, 10)
    const meta = {
      access_level: 'facility',
      facility_id: fac.id,
      facility_name: FACILITY.name,
      admin_state: FACILITY.state,
      facility_role: u.facility_role || 'dispenser',
      commodity_section: u.commodity_section || null,
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
    rows.push([email.replace('@envo.ng',''), password, meta.facility_role, meta.commodity_section || '', email])
    console.log(`  ✓ ${email}  (${meta.facility_role} / ${meta.commodity_section || 'none'})`)
  }

  const out = `scripts/new_facility_${FACILITY.code || 'out'}_logins.csv`
  fs.writeFileSync(out, rows.map(r => r.map(csvCell).join(',')).join('\r\n'))
  console.log(`\nDone. ${USERS.length} logins written to ${out}`)
  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
