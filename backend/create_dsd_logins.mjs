// Create DSD (differentiated service delivery) spoke logins under a hub facility.
// Each login is a facility-level `dsd` account pinned to the HUB facility, tagged
// with its own dsd_site_name + dsd_type. Its stock lives in dsd_stock keyed by
// (hub facility_id, dsd_site_name, commodity_id); the hub redistributes to it.
//
// Idempotent: safe to re-run (hub matched by name, users matched by email).
//
// One batch per hub, selected by argv so each provisioning run stays on record
// instead of being edited over the top of the last one:
//   node create_dsd_logins.mjs ibeno
//   node create_dsd_logins.mjs uuth
//
// Passwords are read from environment variables (never hardcoded — this file is
// committed, and plaintext passwords must not enter git history). Set them inline
// when you run it on the VM, e.g. (PowerShell):
//   cd C:\envo\app\backend
//   $env:DSD_PW_SIBAN='…'; $env:DSD_PW_CHASTAGRA='…'; node create_dsd_logins.mjs uuth
//
import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { syncAcl } from './src/services/aclProvisioning.js'
import { pool as aclPool } from './src/db.js'

// Each batch: the hub facility (matched by EXACT name — must already exist), the
// commodity section its spokes work in, and its spoke sites.
//
// dsd_type must match the values the Transfers dropdown uses exactly:
//   'Decentralized Hub & Spoke' | 'Community Pharmacy' | 'Fast Track'
// email = login identity (the app appends @envo.ng to the typed Username, so the
// username is the local part, e.g. "ibeno.iwuokpum"). `oldEmail` is the address
// the account was first created under; when present the script RENAMES that
// account in place rather than creating a duplicate.
const BATCHES = {
  ibeno: {
    hub: 'Ibeno Cottage Hospital',
    section: 'pharmacy', // these spokes dispense ARVs
    sites: [
      { site: 'Iwuokpum Opolom HC', dsd_type: 'Decentralized Hub & Spoke', email: 'ibeno.iwuokpum@envo.ng',  oldEmail: 'iwuokpum.opolom.dsd@envo.ng', pwEnv: 'DSD_PW_IWUOKPUM' },
      { site: 'Atabrikang HC',      dsd_type: 'Decentralized Hub & Spoke', email: 'ibeno.atabrikang@envo.ng', oldEmail: 'atabrikang.dsd@envo.ng',      pwEnv: 'DSD_PW_ATABRIKANG' },
      { site: 'Uzard pharmacy Eket', dsd_type: 'Community Pharmacy',       email: 'ibeno.uzard@envo.ng',      oldEmail: 'uzard.eket.dsd@envo.ng',       pwEnv: 'DSD_PW_UZARD' },
    ],
  },
  uuth: {
    // Was recorded as "University Teaching Hospital"; corrected by
    // db/migrations/20260808_rename_uuth_facility.sql. Not to be confused with
    // "University of Uyo Medical Centre", the campus clinic — a different facility.
    hub: 'University of Uyo Teaching Hospital',
    section: 'pharmacy',
    sites: [
      { site: 'Siban Pharmacy',     dsd_type: 'Community Pharmacy', email: 'uuth.siban@envo.ng',     pwEnv: 'DSD_PW_SIBAN' },
      { site: 'Chastagra Pharmacy', dsd_type: 'Community Pharmacy', email: 'uuth.chastagra@envo.ng', pwEnv: 'DSD_PW_CHASTAGRA' },
    ],
  },
}

const batchName = process.argv[2]
const batch = BATCHES[batchName]
if (!batch) {
  console.error(`usage: node create_dsd_logins.mjs <batch>   (batches: ${Object.keys(BATCHES).join(', ')})`)
  process.exit(1)
}

const pool = new pg.Pool({
  host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
})

async function run() {
  // Resolve the hub facility once. Abort if it isn't there — creating spokes under a
  // wrong/blank facility_id would orphan their stock.
  const hub = (await pool.query('select id, name from facilities where name = $1', [batch.hub])).rows[0]
  if (!hub) {
    console.error(`✗ hub facility "${batch.hub}" not found — check the exact name. Aborting.`)
    await pool.end()
    process.exit(1)
  }
  console.log(`= hub: ${hub.name}  (${hub.id})`)

  for (const s of batch.sites) {
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
      commodity_section: batch.section,
      dsd_site_name: s.site,
      dsd_type: s.dsd_type,
      email_verified: true,
    }
    const hash = await bcrypt.hash(password, 10)
    const byNew = (await pool.query('select id from users where lower(email) = lower($1)', [s.email])).rows[0]
    const byOld = !byNew && s.oldEmail
      ? (await pool.query('select id from users where lower(email) = lower($1)', [s.oldEmail])).rows[0]
      : null
    if (byNew) {
      await pool.query('update users set encrypted_password = $1, raw_user_meta_data = $2 where id = $3',
        [hash, meta, byNew.id])
      console.log(`= account updated  : ${s.email}  (${s.site} / ${s.dsd_type})`)
    } else if (byOld) {
      // Rename the existing account in place — keeps the same user id (and any
      // stock/activity already tied to it), just switches the login identity.
      await pool.query('update users set email = $1, encrypted_password = $2, raw_user_meta_data = $3 where id = $4',
        [s.email, hash, meta, byOld.id])
      console.log(`~ account renamed  : ${s.oldEmail} -> ${s.email}  (${s.site} / ${s.dsd_type})`)
    } else {
      await pool.query(
        `insert into users (id, email, encrypted_password, raw_user_meta_data)
         values (gen_random_uuid(), $1, $2, $3)`,
        [s.email, hash, meta])
      console.log(`+ account created  : ${s.email}  (${s.site} / ${s.dsd_type})`)
    }
  }

  // Give the new accounts their ACL role and scope. No-ops where the ACL tables
  // are absent (production, today) and never throws. This uses the shared
  // src/db.js pool, which this script does not otherwise touch — so close that
  // one too, or node will not exit.
  await syncAcl()
  await aclPool.end().catch(() => {})

  await pool.end()
  console.log('\ndone')
}

run().catch(e => { console.error(e); process.exit(1) })
