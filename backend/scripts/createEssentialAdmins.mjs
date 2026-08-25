// Create the Essential Commodities ADMIN logins — one per state, one per LGA that
// actually has Essential-enrolled facilities, and optionally one national account.
//
// Why new accounts rather than granting the existing admins: the existing state_admin
// and overall_admin logins predate the generator scripts, so nobody holds their
// passwords. These are created fresh with recorded credentials. (To grant an admin you
// CAN sign in as, use grantEssentialAdmins.mjs instead — same flag, no new account.)
//
// Scope is derived from the data, not hardcoded: an LGA login is created only where
// facility_modules actually enrols a facility in 'essential', so this stays correct as
// the rollout widens. Re-running after more facilities are enrolled adds the new LGAs.
//
// These accounts are OVERSIGHT-ONLY. The essential grant opens the read views
// (Warehouse Requests, Stock Levels, Monitoring, Activity Log) narrowed to their own
// state/LGA; the backend refuses every write from an admin tier in this module.
//
//   node scripts/createEssentialAdmins.mjs                 # state + LGA logins
//   node scripts/createEssentialAdmins.mjs --overall       # …plus a national one
//   node scripts/createEssentialAdmins.mjs --dry-run       # show what it would create
//   node scripts/createEssentialAdmins.mjs out.csv         # choose the output file
//
// Idempotent by e-mail: re-running RESETS the password of an existing account and
// rewrites the CSV, so the file always matches what the accounts actually are.

import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { pool } from '../src/db.js'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const WITH_OVERALL = argv.includes('--overall')
const OUT = argv.find(a => !a.startsWith('--')) || 'scripts/essential_admin_logins.csv'

const CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
function makePassword() {
  let pw
  do { pw = Array.from(crypto.randomBytes(12), b => CHARS[b % CHARS.length]).join('') } while (!/[2-9]/.test(pw))
  return pw
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

// House-style slug: lowercase, letters and digits only. Matches the existing admin
// usernames exactly — 'Ikot Ekpene' → 'ikotekpene' (cf. ikotekpene.cluster.pharmacy),
// 'Akwa Ibom' → 'akwaibom' (cf. akwaibom.admin).
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

async function main() {
  // Only where Essential is actually rolled out. Driving off facility_modules means the
  // script never invents an admin for an area with nothing to oversee.
  const { rows: areas } = await pool.query(
    `select distinct f.state, f.lga
       from facility_modules fm
       join facilities f on f.id = fm.facility_id
      where fm.module = 'essential' and f.state is not null and f.lga is not null
      order by f.state, f.lga`)

  if (!areas.length) {
    console.log('No facilities are enrolled in the essential module — nothing to create.')
    return
  }

  const states = [...new Set(areas.map(a => a.state))]
  const planned = []

  for (const state of states) {
    planned.push({
      email: `${slug(state)}.essential@envo.ng`,
      username: `${slug(state)}.essential`,
      level: 'state_admin', area: state,
      meta: {
        full_name: `${state} Essential Commodities Admin`,
        access_level: 'state_admin',
        admin_state: state,
        email_verified: true,
        essential: true,
      },
    })
  }

  for (const { state, lga } of areas) {
    planned.push({
      email: `${slug(lga)}.lga.essential@envo.ng`,
      username: `${slug(lga)}.lga.essential`,
      level: 'lga_admin', area: `${lga} (${state})`,
      meta: {
        full_name: `${lga} LGA Essential Commodities Admin`,
        access_level: 'lga_admin',
        admin_lga: lga,
        admin_state: state,
        email_verified: true,
        essential: true,
      },
    })
  }

  if (WITH_OVERALL) {
    planned.push({
      email: 'envo.essential@envo.ng', username: 'envo.essential',
      level: 'overall_admin', area: 'national',
      meta: {
        full_name: 'Essential Commodities National Admin',
        access_level: 'overall_admin',
        email_verified: true,
        essential: true,
      },
    })
  }

  // Two LGAs of the same name in different states would collide on the username. Catch
  // it rather than letting the second silently overwrite the first.
  const seen = new Map()
  for (const p of planned) {
    if (seen.has(p.email)) {
      console.error(`Username collision: ${p.username} wanted by both "${seen.get(p.email)}" and "${p.area}".`)
      process.exitCode = 1
      return
    }
    seen.set(p.email, p.area)
  }

  if (DRY) {
    console.log(`Would create/update ${planned.length} login(s):\n`)
    for (const p of planned) console.log(`  ${p.username.padEnd(34)} ${p.level.padEnd(13)} ${p.area}`)
    console.log(`\nCredentials would be written to: ${OUT}`)
    return
  }

  const rows = [['username', 'password', 'access_level', 'area', 'modules', 'email']]
  for (const p of planned) {
    const password = makePassword()
    const hash = await bcrypt.hash(password, 10)
    await pool.query(
      `insert into users (id, email, encrypted_password, raw_user_meta_data)
       values (gen_random_uuid(), $1, $2, $3::jsonb)
       on conflict (email) do update
         set encrypted_password = excluded.encrypted_password,
             raw_user_meta_data = excluded.raw_user_meta_data`,
      [p.email, hash, JSON.stringify(p.meta)])
    rows.push([p.username, password, p.level, p.area, 'HIV + Essential', p.email])
  }

  fs.writeFileSync(OUT, rows.map(r => r.map(csvCell).join(',')).join('\r\n'))
  const byLevel = planned.reduce((m, p) => (m[p.level] = (m[p.level] || 0) + 1, m), {})
  console.log(`Essential admin logins created/updated: ${planned.length}`)
  for (const [lvl, n] of Object.entries(byLevel)) console.log(`  ${lvl}: ${n}`)
  console.log(`Credentials written to: ${OUT}`)
  // These accounts can also open HIV — admin tiers see every module, and only Essential
  // is grant-gated. Their oversight is read-only and scoped either way.
  console.log('\nNote: these are oversight-only, and scoped to their own state/LGA.')
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => pool.end())
