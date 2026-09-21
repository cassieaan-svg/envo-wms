// Give every REAL Essential Commodities account its own UNIQUE password — WITHOUT
// touching raw_user_meta_data (facility/LGA/state scope stays exactly as already
// configured). Two problems this fixes at once:
//
//   1. createEssentialAdmins.mjs / addEssentialFacilityRoster.mjs mint a NEW
//      random password on every run, so anyone who re-ran them silently
//      invalidated whatever credentials had already been handed out.
//   2. A single shared password across every account (the first version of this
//      script) is a real security problem even for a test system — one leaked
//      credential opens every facility and every admin tier at once.
//
// Fixed by making this idempotent PER ACCOUNT: it reads the CSV this script
// already wrote (if present) and keeps whatever password an account already
// has there, generating a fresh unique one only for accounts that are new since
// the last run. So re-running never breaks a credential someone was already
// handed, and no two accounts ever share a password.
//
//   node scripts/resetEssentialPasswords.mjs
//   node scripts/resetEssentialPasswords.mjs --dry-run
//   node scripts/resetEssentialPasswords.mjs --rotate-all   # force a fresh password for EVERY account

import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'

const pool = new pg.Pool({
  host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
})

const DRY = process.argv.includes('--dry-run')
const ROTATE_ALL = process.argv.includes('--rotate-all')
const OUT = 'scripts/essential_real_logins_reset.csv'

// Same style as createEssentialAdmins.mjs: unambiguous characters, guaranteed a digit.
const CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
function makePassword() {
  let pw
  do { pw = Array.from(crypto.randomBytes(12), b => CHARS[b % CHARS.length]).join('') } while (!/[2-9]/.test(pw))
  return pw
}

function readExisting() {
  if (!fs.existsSync(OUT)) return new Map()
  const text = fs.readFileSync(OUT, 'utf8')
  const [head, ...lines] = text.split(/\r?\n/).filter(Boolean)
  const cols = head.split(',')
  const emailIdx = cols.indexOf('email'), pwIdx = cols.indexOf('password')
  const map = new Map()
  for (const line of lines) {
    // Simple split is safe here: none of our own fields ever contain a comma.
    const cells = line.split(',')
    if (cells[emailIdx] && cells[pwIdx]) map.set(cells[emailIdx], cells[pwIdx])
  }
  return map
}

async function main() {
  const { rows } = await pool.query(`
    select u.id, u.email,
           u.raw_user_meta_data->>'access_level'  as access_level,
           u.raw_user_meta_data->>'facility_name'  as facility_name,
           u.raw_user_meta_data->>'facility_role'  as facility_role,
           u.raw_user_meta_data->>'admin_state'    as admin_state,
           u.raw_user_meta_data->>'admin_lga'      as admin_lga,
           u.raw_user_meta_data->>'admin_level'    as admin_level,
           u.raw_user_meta_data->>'full_name'      as full_name,
           f.state as facility_state, f.lga as facility_lga
      from users u
      left join facilities f on f.name = u.raw_user_meta_data->>'facility_name'
     where u.raw_user_meta_data->>'essential' = 'true'
        or u.raw_user_meta_data->>'access_level' = 'essential_admin'
        or u.email = 'sysadmin.essential@envo.ng'
     order by access_level, email
  `)

  console.log(`${rows.length} real Essential Commodities account(s) found.`)
  const existing = ROTATE_ALL ? new Map() : readExisting()
  const kept = rows.filter(r => existing.has(r.email)).length
  console.log(`${kept} already have a recorded password and will keep it; ${rows.length - kept} will get a new one.`)

  if (DRY) {
    for (const r of rows) console.log(`  ${r.email.padEnd(45)} ${r.access_level}  ${existing.has(r.email) ? '(kept)' : '(new)'}`)
    console.log('\n--dry-run: no passwords changed.')
    await pool.end()
    return
  }

  const head = ['username', 'password', 'access_level', 'facility_state_or_admin_area', 'facility_lga_or_role', 'email']
  const csvRows = [head]
  for (const r of rows) {
    const password = existing.get(r.email) || makePassword()
    const hash = await bcrypt.hash(password, 10)
    await pool.query('update users set encrypted_password = $1 where id = $2', [hash, r.id])

    const username = r.email.replace('@envo.ng', '')
    const area = r.access_level === 'facility' ? (r.facility_state || r.admin_state || '') : (r.admin_state || 'national')
    const sub = r.access_level === 'facility' ? (r.facility_lga || '') : (r.admin_lga || r.admin_level || r.facility_role || '')
    csvRows.push([username, password, r.access_level, area, sub, r.email])
  }
  const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  fs.writeFileSync(OUT, csvRows.map(row => row.map(csvCell).join(',')).join('\r\n'))

  console.log(`Done: ${rows.length} accounts each have their own unique password.`)
  console.log(`Full list written to ${OUT}`)
  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
