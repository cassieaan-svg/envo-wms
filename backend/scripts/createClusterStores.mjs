// Create the Cross River CLUSTER LAB STORES and their store-manager logins.
//
// A cluster store sits between the State Office Store and the facilities: it holds
// stock, receives from the state office and dispatches to the facilities in its
// cluster. It is modelled exactly on the State Office Store — access_level 'facility',
// facility_role 'store_manager', commodity_section 'lab' — one level down.
//
// STORE MANAGERS ONLY. No dispensers and no SDP logins: a cluster store keeps and moves
// stock, it does not dispense to patients.
//
// `lga` is NULL, as it is for a State Office Store: the store serves a whole cluster and
// belongs to no single LGA. `cluster` IS set, so cluster-scoped admins and the facility
// pickers place it correctly.
//
// Cross River only, as asked. Its three clusters (Central, Northern, Southern) are used
// by no other state, so the names are unambiguous.
//
//   node scripts/createClusterStores.mjs             # create/update + write the CSV
//   node scripts/createClusterStores.mjs --dry-run   # show what it would do
//
// Idempotent: the facility is matched by name and the login by e-mail, so re-running
// updates rather than duplicating. Re-running DOES reset the passwords and rewrite the
// CSV, so the file always matches the accounts.

import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { pool } from '../src/db.js'
import { syncAcl } from '../src/services/aclProvisioning.js'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const OUT = argv.find(a => !a.startsWith('--')) || 'scripts/cluster_store_logins.csv'

const STATE = 'Cross River'
const CLUSTERS = [
  { cluster: 'Central',  code: 'CRS-CEN-CS' },
  { cluster: 'Northern', code: 'CRS-NOR-CS' },
  { cluster: 'Southern', code: 'CRS-SOU-CS' },
]

const CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
function makePassword() {
  let pw
  do { pw = Array.from(crypto.randomBytes(12), b => CHARS[b % CHARS.length]).join('') } while (!/[2-9]/.test(pw))
  return pw
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

async function main() {
  // Refuse to invent a store for a cluster that has no facilities — that would be a
  // store with nobody to serve, and the sort of row that later reads as junk data.
  const { rows: present } = await pool.query(
    'select cluster, count(*)::int n from facilities where state = $1 and cluster = any($2) group by cluster',
    [STATE, CLUSTERS.map(c => c.cluster)])
  const counts = Object.fromEntries(present.map(r => [r.cluster, r.n]))
  const missing = CLUSTERS.filter(c => !counts[c.cluster])
  if (missing.length) {
    console.error(`No ${STATE} facilities in cluster(s): ${missing.map(m => m.cluster).join(', ')} — aborting.`)
    process.exitCode = 1
    return
  }

  const planned = CLUSTERS.map(c => ({
    ...c,
    name: `${c.cluster} Cluster Lab Store`,
    username: `${slug(c.cluster)}.clusterstore.lab`,
    email: `${slug(c.cluster)}.clusterstore.lab@envo.ng`,
    serves: counts[c.cluster],
  }))

  if (DRY) {
    console.log(`Would create/update ${planned.length} cluster store(s) in ${STATE}:\n`)
    for (const p of planned) {
      console.log(`  ${p.name.padEnd(30)} ${p.code.padEnd(12)} login ${p.username.padEnd(30)} serves ${p.serves} facilities`)
    }
    console.log(`\nCredentials would be written to: ${OUT}`)
    return
  }

  const rows = [['username', 'password', 'facility', 'code', 'cluster', 'state', 'role', 'section', 'email']]
  for (const p of planned) {
    // Facility first — the login carries its id in the token.
    // Select-then-write, NOT `on conflict (name)`: facilities has no unique constraint
    // on name (only the primary key), so an upsert on it fails at runtime.
    const { rows: found } = await pool.query('select id, name from facilities where name = $1', [p.name])
    let facility
    if (found[0]) {
      const { rows: upd } = await pool.query(
        'update facilities set code = $2, state = $3, lga = null, cluster = $4 where id = $1 returning id, name',
        [found[0].id, p.code, STATE, p.cluster])
      facility = upd[0]
    } else {
      const { rows: ins } = await pool.query(
        `insert into facilities (id, name, code, state, lga, cluster)
         values (gen_random_uuid(), $1, $2, $3, null, $4) returning id, name`,
        [p.name, p.code, STATE, p.cluster])
      facility = ins[0]
    }

    const password = makePassword()
    const hash = await bcrypt.hash(password, 10)
    // Mirrors the State Office Store login exactly, one level down.
    const meta = {
      access_level: 'facility',
      facility_id: facility.id,
      facility_name: facility.name,
      facility_role: 'store_manager',
      commodity_section: 'lab',
      admin_state: STATE,
      email_verified: true,
    }
    await pool.query(
      `insert into users (id, email, encrypted_password, raw_user_meta_data)
       values (gen_random_uuid(), $1, $2, $3::jsonb)
       on conflict (email) do update
         set encrypted_password = excluded.encrypted_password,
             raw_user_meta_data = excluded.raw_user_meta_data`,
      [p.email, hash, JSON.stringify(meta)])

    rows.push([p.username, password, facility.name, p.code, p.cluster, STATE, 'store_manager', 'lab', p.email])
    console.log(`  ${facility.name.padEnd(30)} login ${p.username}`)
  }

  fs.writeFileSync(OUT, rows.map(r => r.map(csvCell).join(',')).join('\r\n'))
  console.log(`\n${planned.length} cluster store(s) and store-manager login(s) created/updated.`)
  console.log(`Credentials written to: ${OUT}`)

  // Give the new accounts their ACL role and scope. No-ops where the ACL tables
  // are absent (production, today) and never throws.
  await syncAcl()
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => pool.end())
