// Reset every REAL Essential Commodities account's password to one fixed, known
// value — WITHOUT touching raw_user_meta_data (facility/LGA/state scope stays
// exactly as already configured). This is the fix for "former logins stopped
// working": createEssentialAdmins.mjs / addEssentialFacilityRoster.mjs mint a
// NEW random password on every run, so anyone who re-ran them silently
// invalidated whatever credentials had already been handed out. This script is
// safe to re-run any number of times — it always lands on the same password.
//
//   node scripts/resetEssentialPasswords.mjs
//   node scripts/resetEssentialPasswords.mjs --dry-run

import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import fs from 'node:fs'

const pool = new pg.Pool({
  host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
})

const DRY = process.argv.includes('--dry-run')
const PASSWORD = 'Envo2026!'

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
  if (DRY) {
    for (const r of rows) console.log(`  ${r.email.padEnd(45)} ${r.access_level}`)
    console.log('\n--dry-run: no passwords changed.')
    await pool.end()
    return
  }

  const hash = await bcrypt.hash(PASSWORD, 10)
  for (const r of rows) {
    await pool.query('update users set encrypted_password = $1 where id = $2', [hash, r.id])
  }

  const head = ['username', 'password', 'access_level', 'facility_state_or_admin_area', 'facility_lga_or_role', 'email']
  const csvRows = [head]
  for (const r of rows) {
    const username = r.email.replace('@envo.ng', '')
    const area = r.access_level === 'facility' ? (r.facility_state || r.admin_state || '') : (r.admin_state || 'national')
    const sub = r.access_level === 'facility' ? (r.facility_lga || '') : (r.admin_lga || r.admin_level || r.facility_role || '')
    csvRows.push([username, PASSWORD, r.access_level, area, sub, r.email])
  }
  const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  fs.writeFileSync('scripts/essential_real_logins_reset.csv',
    csvRows.map(row => row.map(csvCell).join(',')).join('\r\n'))

  console.log(`Password reset to a fixed value for all ${rows.length} accounts.`)
  console.log(`Password: ${PASSWORD}`)
  console.log('Full list written to scripts/essential_real_logins_reset.csv')
  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
