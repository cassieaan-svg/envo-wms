// Create DSD (differentiated service delivery) spoke logins under a hub facility.
// Each login is a facility-level `dsd` account pinned to the HUB facility, tagged
// with its own dsd_site_name + dsd_type. Its stock lives in dsd_stock keyed by
// (hub facility_id, dsd_site_name, commodity_id); the hub redistributes to it.
//
// Idempotent: safe to re-run (hub matched by name, users matched by email).
//
// Passwords are read from environment variables (never hardcoded — this file is
// committed, and plaintext passwords must not enter git history). Set them inline
// when you run it on the VM, e.g. (PowerShell):
//   cd C:\envo\app\backend
//   $env:DSD_PW_IWUOKPUM='…'; $env:DSD_PW_ATABRIKANG='…'; $env:DSD_PW_UZARD='…'; node create_dsd_logins.mjs
//
import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcryptjs'

// The hub these spokes hang off. Matched by exact name — must already exist.
const HUB_NAME = 'Cottage Hospital Ibeno'

// dsd_type must match the values the Transfers dropdown uses exactly:
//   'Decentralized Hub & Spoke' | 'Community Pharmacy' | 'Fast Track'
const SITES = [
  { site: 'Iwuokpum Opolom HC', dsd_type: 'Decentralized Hub & Spoke', email: 'iwuokpum.opolom.dsd@envo.ng', pwEnv: 'DSD_PW_IWUOKPUM' },
  { site: 'Atabrikang HC',      dsd_type: 'Decentralized Hub & Spoke', email: 'atabrikang.dsd@envo.ng',      pwEnv: 'DSD_PW_ATABRIKANG' },
  { site: 'Uzard pharmacy Eket', dsd_type: 'Community Pharmacy',       email: 'uzard.eket.dsd@envo.ng',       pwEnv: 'DSD_PW_UZARD' },
]

const SECTION = 'pharmacy' // these spokes dispense ARVs

const pool = new pg.Pool({
  host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
})

async function run() {
  // Resolve the hub facility once. Abort if it isn't there — creating spokes under a
  // wrong/blank facility_id would orphan their stock.
  const hub = (await pool.query('select id, name from facilities where name = $1', [HUB_NAME])).rows[0]
  if (!hub) {
    console.error(`✗ hub facility "${HUB_NAME}" not found — check the exact name. Aborting.`)
    await pool.end()
    process.exit(1)
  }
  console.log(`= hub: ${hub.name}  (${hub.id})`)

  for (const s of SITES) {
    const password = process.env[s.pwEnv]
    if (!password) {
      console.error(`✗ ${s.site}: env var ${s.pwEnv} not set — skipped`)
      continue
    }

    const meta = {
      access_level: 'facility',
      facility_id: hub.id,
      facility_name: hub.name,
      facility_role: 'dsd',
      commodity_section: SECTION,
      dsd_site_name: s.site,
      dsd_type: s.dsd_type,
      email_verified: true,
    }
    const hash = await bcrypt.hash(password, 10)
    const existing = (await pool.query('select id from users where lower(email) = lower($1)', [s.email])).rows[0]
    if (existing) {
      await pool.query('update users set encrypted_password = $1, raw_user_meta_data = $2 where id = $3',
        [hash, meta, existing.id])
      console.log(`= account updated  : ${s.email}  (${s.site} / ${s.dsd_type})`)
    } else {
      await pool.query(
        `insert into users (id, email, encrypted_password, raw_user_meta_data)
         values (gen_random_uuid(), $1, $2, $3)`,
        [s.email, hash, meta])
      console.log(`+ account created  : ${s.email}  (${s.site} / ${s.dsd_type})`)
    }
  }
  await pool.end()
  console.log('\ndone')
}

run().catch(e => { console.error(e); process.exit(1) })
