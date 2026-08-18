// Create a SEPARATE pharmacy store-manager login per Essential-enrolled facility that
// can open both modules (HIV + Essential Commodities). The existing pharmmanager login
// stays HIV-only — Essential is gated on a per-login `essential: true` grant (see
// middleware/scope.js), which only these new logins carry.
//
// For each facility enrolled in the 'essential' module we find its existing pharmacy
// store-manager account, copy its metadata (facility, state, section, role) into a new
// `<slug>.essential@envo.ng` login, and add the grant. Idempotent (upsert by email);
// random passwords written to a gitignored *_logins*.csv.
//
//   node scripts/addEssentialStoreManagers.mjs [outfile.csv]

import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { pool } from '../src/db.js'

const OUT = process.argv[2] || 'scripts/essential_store_manager_logins.csv'
const CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
function makePassword() {
  let pw
  do { pw = Array.from(crypto.randomBytes(12), b => CHARS[b % CHARS.length]).join('') } while (!/[2-9]/.test(pw))
  return pw
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

async function main() {
  // The existing pharmacy store-manager account for every Essential-enrolled facility.
  // It gives us the house-style slug and the exact metadata shape to clone.
  const seeds = (await pool.query(
    `select u.email, u.raw_user_meta_data as meta
       from users u
      where u.raw_user_meta_data->>'facility_role' = 'store_manager'
        and u.raw_user_meta_data->>'commodity_section' = 'pharmacy'
        and (u.raw_user_meta_data->>'facility_id')::uuid in (
              select facility_id from facility_modules where module = 'essential')
      order by u.email`
  )).rows

  const rows = [['username', 'password', 'facility', 'state', 'modules', 'email']]
  const skipped = []
  let created = 0

  for (const seed of seeds) {
    const meta = seed.meta || {}
    // slug = local-part up to the last dot (drops the '.pharmmanager' subunit), so the
    // new login is '<slug>.essential' regardless of the seed account's subunit name.
    const local = seed.email.replace(/@envo\.ng$/i, '')
    const slug = local.includes('.') ? local.slice(0, local.lastIndexOf('.')) : local
    if (!slug || !meta.facility_id) { skipped.push(seed.email); continue }

    const email = `${slug}.essential@envo.ng`
    const password = makePassword()
    const hash = await bcrypt.hash(password, 10)
    const newMeta = {
      ...meta,
      facility_role: 'store_manager',
      commodity_section: 'pharmacy',
      access_level: 'facility',
      email_verified: true,
      essential: true, // the per-login grant that opens Essential Commodities
    }

    await pool.query(
      `insert into users (id, email, encrypted_password, raw_user_meta_data)
       values (gen_random_uuid(), $1, $2, $3::jsonb)
       on conflict (email) do update
         set encrypted_password = excluded.encrypted_password,
             raw_user_meta_data = excluded.raw_user_meta_data`,
      [email, hash, JSON.stringify(newMeta)]
    )
    rows.push([`${slug}.essential`, password, meta.facility_name || '', meta.admin_state || '', 'HIV + Essential', email])
    created += 1
  }

  fs.writeFileSync(OUT, rows.map(r => r.map(csvCell).join(',')).join('\r\n'))
  console.log(`Essential-enrolled facilities with a pharmacy store-manager: ${seeds.length}`)
  console.log(`Dual-module store-manager logins created/updated: ${created}`)
  if (skipped.length) console.log(`Skipped (no slug/facility): ${skipped.length} — ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}`)
  console.log(`Credentials written to: ${OUT}`)
  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
