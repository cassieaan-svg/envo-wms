// Section-scoped state viewer logins: one read-only viewer per state × section
// (pharmacy, lab). Each sees ALL of that section's commodities across the whole
// state, with LGA → Facility filtering, and cannot write anything.
//
//   node scripts/generateStateSectionViewers.mjs [outfile.csv]
//
// access_level = state_viewer + admin_state + commodity_section. Upserts by email
// (bcryptjs, same as login), each with a UNIQUE RANDOM password, all written to a
// gitignored *_logins*.csv for hand-off. Usernames = the email local-part; the
// login form appends "@envo.ng". Idempotent on the account set (new password each
// run — provision once and keep the CSV).

import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pool } from '../src/db.js'

const OUT = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'state_section_viewer_logins.csv')
const SECTIONS = ['pharmacy', 'lab']

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '')
const CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
function makePassword() {
  let pw
  do { pw = Array.from(crypto.randomBytes(12), b => CHARS[b % CHARS.length]).join('') } while (!/[2-9]/.test(pw))
  return pw
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

async function main() {
  const states = (await pool.query(`select distinct state from facilities where state is not null order by 1`)).rows.map(r => r.state)

  const accounts = []
  for (const state of states) for (const section of SECTIONS) {
    accounts.push({
      email: `${slug(state)}.state.${section}@envo.ng`,
      meta: { access_level: 'state_viewer', admin_state: state, commodity_section: section, email_verified: true },
      section, scope: state,
    })
  }

  const seen = new Map()
  for (const a of accounts) {
    if (seen.has(a.email)) throw new Error(`Duplicate username "${a.email}" — states "${seen.get(a.email)}" and "${a.scope}" slug identically; disambiguate first.`)
    seen.set(a.email, a.scope)
  }

  const rows = [['username', 'password', 'access_level', 'section', 'state', 'email']]
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
    rows.push([a.email.replace('@envo.ng', ''), password, 'state_viewer', a.section, a.scope, a.email])
  }

  fs.writeFileSync(OUT, rows.map(r => r.map(csvCell).join(',')).join('\r\n'))
  console.log(`Provisioned ${accounts.length} section-scoped state viewers (${states.length} states x 2 sections).`)
  console.log(`Credentials written to: ${OUT}`)
  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
