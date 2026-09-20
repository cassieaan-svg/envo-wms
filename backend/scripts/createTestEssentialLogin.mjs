import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcryptjs'

const pool = new pg.Pool({
  host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
})

const FACILITY = { name: 'Test Essential Facility', code: 'TEF-001', state: 'Akwa Ibom', lga: 'Uyo', cluster: 'Uyo' }
const SLUG = 'testessential'
const PASSWORD = 'Envo2026!'

async function main() {
  let fac = (await pool.query('select id from facilities where name = $1 and state = $2', [FACILITY.name, FACILITY.state])).rows[0]
  if (!fac) {
    fac = (await pool.query(
      `insert into facilities (id, name, code, state, lga, cluster)
       values (gen_random_uuid(), $1, $2, $3, $4, $5) returning id`,
      [FACILITY.name, FACILITY.code, FACILITY.state, FACILITY.lga, FACILITY.cluster])).rows[0]
    console.log(`Facility created: ${FACILITY.name} (${fac.id})`)
  } else {
    console.log(`Facility already exists (${fac.id}) — reusing it.`)
  }

  await pool.query(
    `insert into facility_modules (facility_id, module) values ($1, 'essential') on conflict do nothing`,
    [fac.id]
  )

  const email = `${SLUG}.essential@envo.ng`
  const hash = await bcrypt.hash(PASSWORD, 10)
  const meta = {
    access_level: 'facility',
    facility_id: fac.id,
    facility_name: FACILITY.name,
    admin_state: FACILITY.state,
    facility_role: 'store_manager',
    commodity_section: 'pharmacy',
    email_verified: true,
    essential: true,
  }
  await pool.query(
    `insert into users (id, email, encrypted_password, raw_user_meta_data)
     values (gen_random_uuid(), $1, $2, $3::jsonb)
     on conflict (email) do update
       set encrypted_password = excluded.encrypted_password,
           raw_user_meta_data = excluded.raw_user_meta_data`,
    [email, hash, JSON.stringify(meta)]
  )

  console.log(`\nLogin ready:`)
  console.log(`  username: ${SLUG}.essential`)
  console.log(`  password: ${PASSWORD}`)
  console.log(`  facility: ${FACILITY.name} (${FACILITY.lga}, ${FACILITY.state})`)
  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
