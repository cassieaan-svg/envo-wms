// Generate the FULL canonical set of read-only oversight accounts from the
// database, so admin_state / admin_cluster / admin_lga match facilities exactly.
//
//   state_viewer  — 1 per state           (both sections)
//   cluster_admin — 1 per cluster × section (pharmacy, lab)  read-only
//   lga_admin     — 1 per LGA × section     (pharmacy, lab)  read-only
//
// Each account gets a UNIQUE RANDOM password. Accounts are upserted by email
// (bcryptjs hash, same as the login path) and every credential is written to a
// CSV for hand-off. Usernames are the email local-part; the login form appends
// "@envo.ng".
//
//   node scripts/generateViewers.mjs [outfile.csv]
//
// Idempotent on the account set, but each run mints NEW random passwords — run
// once for provisioning and keep the CSV it prints. CSV path defaults to a
// gitignored "*_logins*.csv" so plaintext passwords can't be committed.

import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pool } from '../src/db.js'

const OUT = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'viewer_logins.csv')
const SECTIONS = ['pharmacy', 'lab']

// Username-safe slug: lowercase, drop everything but a–z/0–9.
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '')

// Readable but strong password: 12 chars, unambiguous charset, ≥1 digit.
const CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
function makePassword() {
  let pw
  do {
    pw = Array.from(crypto.randomBytes(12), b => CHARS[b % CHARS.length]).join('')
  } while (!/[2-9]/.test(pw))   // guarantee at least one digit
  return pw
}

const csvCell = v => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function main() {
  // Canonical scopes straight from the facilities table.
  const states   = (await pool.query(`select distinct state from facilities where state is not null order by 1`)).rows.map(r => r.state)
  const clusters = (await pool.query(`select distinct cluster from facilities where cluster is not null order by 1`)).rows.map(r => r.cluster)
  const lgas     = (await pool.query(`select distinct lga from facilities where lga is not null order by 1`)).rows.map(r => r.lga)

  // Build the account list: email + metadata + human-readable scope columns.
  const accounts = []
  for (const state of states) {
    accounts.push({
      email: `${slug(state)}.state@envo.ng`,
      meta: { access_level: 'state_viewer', admin_state: state, email_verified: true },
      role: 'state_viewer', section: 'both', scope: state,
    })
  }
  for (const cluster of clusters) for (const section of SECTIONS) {
    accounts.push({
      email: `${slug(cluster)}.cluster.${section}@envo.ng`,
      meta: { access_level: 'cluster_admin', admin_cluster: cluster, commodity_section: section, email_verified: true },
      role: 'cluster_admin', section, scope: cluster,
    })
  }
  for (const lga of lgas) for (const section of SECTIONS) {
    accounts.push({
      email: `${slug(lga)}.lga.${section}@envo.ng`,
      meta: { access_level: 'lga_admin', admin_lga: lga, commodity_section: section, email_verified: true },
      role: 'lga_admin', section, scope: lga,
    })
  }

  // Fail loudly on any duplicate username (e.g. two LGAs slugging identically).
  const seen = new Map()
  for (const a of accounts) {
    if (seen.has(a.email)) throw new Error(`Duplicate username "${a.email}" — scopes "${seen.get(a.email)}" and "${a.scope}" collide; disambiguate before running.`)
    seen.set(a.email, a.scope)
  }

  const rows = [['username', 'password', 'access_level', 'section', 'scope', 'email']]
  for (const a of accounts) {
    const password = makePassword()
    const hash = await bcrypt.hash(password, 10)
    await pool.query(
      `insert into users (id, email, encrypted_password, raw_user_meta_data)
       values (gen_random_uuid(), $1, $2, $3::jsonb)
       on conflict (email) do update
         set encrypted_password = excluded.encrypted_password,
             raw_user_meta_data = excluded.raw_user_meta_data`,
      [a.email, hash, JSON.stringify(a.meta)]
    )
    rows.push([a.email.replace('@envo.ng', ''), password, a.meta.access_level, a.section, a.scope, a.email])
  }

  fs.writeFileSync(OUT, rows.map(r => r.map(csvCell).join(',')).join('\r\n'))
  const byRole = accounts.reduce((m, a) => (m[a.role] = (m[a.role] || 0) + 1, m), {})
  console.log(`Provisioned ${accounts.length} accounts:`, byRole)
  console.log(`Credentials written to: ${OUT}`)
  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
