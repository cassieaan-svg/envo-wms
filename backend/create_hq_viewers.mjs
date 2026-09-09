// Create the national, read-only, section-scoped viewers: Lab HQ and Pharmacy HQ.
// Each is an overall_admin (national scope + read-only) tagged with a
// commodity_section, so the UI shows only that section's data. Idempotent
// (matches by email — safe to re-run).
//
//   1. Set a strong password for each below (replace CHANGE_ME_*).
//   2. On the VM:  cd backend && node create_hq_viewers.mjs
import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { syncAcl } from './src/services/aclProvisioning.js'
import { pool as aclPool } from './src/db.js'

const VIEWERS = [
  { fullName: 'Lab HQ',      section: 'lab',      email: 'labhq@envo.ng',      password: 'CHANGE_ME_1' },
  { fullName: 'Pharmacy HQ', section: 'pharmacy', email: 'pharmacyhq@envo.ng', password: 'CHANGE_ME_2' },
]

const pool = new pg.Pool({
  host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
})

async function run() {
  for (const v of VIEWERS) {
    if (!v.password || v.password.startsWith('CHANGE_ME')) {
      console.error(`✗ ${v.fullName}: set a real password before running — skipped`)
      continue
    }
    const meta = {
      full_name: v.fullName,
      access_level: 'overall_admin',   // national scope + read-only tier
      commodity_section: v.section,    // filters the UI to lab / pharmacy
      email_verified: true,
    }
    const hash = await bcrypt.hash(v.password, 10)
    const existing = (await pool.query('select id from users where lower(email) = lower($1)', [v.email])).rows[0]
    if (existing) {
      await pool.query('update users set encrypted_password = $1, raw_user_meta_data = $2 where id = $3',
        [hash, meta, existing.id])
      console.log(`= account updated : ${v.email}  (${v.fullName})`)
    } else {
      await pool.query(
        `insert into users (id, email, encrypted_password, raw_user_meta_data)
         values (gen_random_uuid(), $1, $2, $3)`,
        [v.email, hash, meta])
      console.log(`+ account created : ${v.email}  (${v.fullName} — overall_admin + section ${v.section})`)
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
