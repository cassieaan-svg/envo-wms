// Create the per-state "State Office Store" facilities + their LAB store_manager
// account. Idempotent: safe to re-run (matches facility by name, user by email).
//
//   1. Set a strong password for each office below (replace CHANGE_ME_*).
//   2. On the VM:  cd backend && node create_state_offices.mjs
//
// Each office is a state-tier facility (no LGA/cluster) with one lab-section
// store_manager to operate it (record intake, dispatch redistributions).
import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcryptjs'

const OFFICES = [
  { state: 'Akwa Ibom',   name: 'Akwa Ibom State Office Store',   code: 'AKS-SO', email: 'akwaibom.stateoffice.lab@envo.ng',   password: 'CHANGE_ME_1' },
  { state: 'Cross River', name: 'Cross River State Office Store', code: 'CRS-SO', email: 'crossriver.stateoffice.lab@envo.ng', password: 'CHANGE_ME_2' },
  { state: 'Lagos',       name: 'Lagos State Office Store',       code: 'LAG-SO', email: 'lagos.stateoffice.lab@envo.ng',      password: 'CHANGE_ME_3' },
]

const pool = new pg.Pool({
  host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
})

async function run() {
  for (const o of OFFICES) {
    if (!o.password || o.password.startsWith('CHANGE_ME')) {
      console.error(`✗ ${o.name}: set a real password before running — skipped`)
      continue
    }

    // 1) Facility (state-tier: lga/cluster null). Match by name so re-runs don't duplicate.
    let fac = (await pool.query('select id from facilities where name = $1', [o.name])).rows[0]
    if (!fac) {
      fac = (await pool.query(
        `insert into facilities (name, code, state, lga, cluster)
         values ($1, $2, $3, null, null) returning id`,
        [o.name, o.code, o.state])).rows[0]
      console.log(`+ facility created : ${o.name}  (${fac.id})`)
    } else {
      console.log(`= facility exists  : ${o.name}  (${fac.id})`)
    }

    // 2) Lab store_manager account. Match by email so re-runs update rather than duplicate.
    const meta = {
      admin_state: o.state,
      facility_id: fac.id,
      access_level: 'facility',
      facility_name: o.name,
      facility_role: 'store_manager',
      email_verified: true,
      commodity_section: 'lab',
    }
    const hash = await bcrypt.hash(o.password, 10)
    const existing = (await pool.query('select id from users where lower(email) = lower($1)', [o.email])).rows[0]
    if (existing) {
      await pool.query('update users set encrypted_password = $1, raw_user_meta_data = $2 where id = $3',
        [hash, meta, existing.id])
      console.log(`= account updated  : ${o.email}`)
    } else {
      await pool.query(
        `insert into users (id, email, encrypted_password, raw_user_meta_data)
         values (gen_random_uuid(), $1, $2, $3)`,
        [o.email, hash, meta])
      console.log(`+ account created  : ${o.email}  (lab store_manager)`)
    }
  }
  await pool.end()
  console.log('\ndone')
}

run().catch(e => { console.error(e); process.exit(1) })
