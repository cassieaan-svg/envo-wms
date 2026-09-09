// Seed / provision read-only oversight accounts for the redesigned access model.
//
//   state_viewer  — whole state (admin_state), both sections, read-only
//   cluster_admin — one cluster (admin_cluster) + one section, read-only
//   lga_admin     — one LGA (admin_lga) + one section, read-only
//
// This is both the local test fixture and the provisioning template: copy a block,
// change email / admin_* / commodity_section, and re-run. Idempotent (upsert by
// email). Passwords are hashed with the same bcryptjs the login path verifies.
//
//   node scripts/seedViewers.js [password]
//
// Metadata lives in users.raw_user_meta_data (→ JWT user_metadata). Scoping fields:
//   access_level, admin_state, admin_cluster, admin_lga, commodity_section.

import bcrypt from 'bcryptjs'
import { pool } from '../src/db.js'
import { syncAcl } from '../src/services/aclProvisioning.js'

const password = process.argv[2] || 'Viewer@123'

// email → metadata. Adjust freely; these mirror the cluster_lga grouping.
const ACCOUNTS = [
  { email: 'akwaibom.stateviewer@envo.ng',
    meta: { access_level: 'state_viewer', admin_state: 'Akwa Ibom', email_verified: true } },

  { email: 'uyo.cluster.pharmacy@envo.ng',
    meta: { access_level: 'cluster_admin', admin_cluster: 'Uyo', commodity_section: 'pharmacy', email_verified: true } },
  { email: 'uyo.cluster.lab@envo.ng',
    meta: { access_level: 'cluster_admin', admin_cluster: 'Uyo', commodity_section: 'lab', email_verified: true } },

  { email: 'uyo.lga.pharmacy@envo.ng',
    meta: { access_level: 'lga_admin', admin_lga: 'Uyo', commodity_section: 'pharmacy', email_verified: true } },
  { email: 'uyo.lga.lab@envo.ng',
    meta: { access_level: 'lga_admin', admin_lga: 'Uyo', commodity_section: 'lab', email_verified: true } },
]

async function main() {
  const hash = await bcrypt.hash(password, 10)
  for (const a of ACCOUNTS) {
    await pool.query(
      `insert into users (id, email, encrypted_password, raw_user_meta_data)
       values (gen_random_uuid(), $1, $2, $3::jsonb)
       on conflict (email) do update
         set encrypted_password = excluded.encrypted_password,
             raw_user_meta_data = excluded.raw_user_meta_data`,
      [a.email, hash, JSON.stringify(a.meta)]
    )
    console.log(`  ✓ ${a.email}  (${a.meta.access_level}${a.meta.commodity_section ? '/' + a.meta.commodity_section : ''})`)
  }
  console.log(`\nSeeded ${ACCOUNTS.length} accounts. Password: ${password}`)

  // Give the new accounts their ACL role and scope. No-ops where the ACL tables
  // are absent (production, today) and never throws.
  await syncAcl()

  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
