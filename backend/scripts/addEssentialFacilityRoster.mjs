// Provision the Essential Commodities facility roster from Akwa Ibom's own facility
// lists (Secondary Health Facility List + List of PHCs by functionality), treating
// them as the authoritative user list rather than trying to map each row onto an
// existing HIV facility record — that mapping turned out to be unreliable, so every
// row here gets its OWN facility record and its OWN login, independent of anything
// already in `facilities`.
//
// Each new facility is enrolled in facility_modules for 'essential' ONLY — not
// 'hiv' — so on the module picker HIV shows up greyed out (not enrolled) and only
// Essential opens, exactly like any other module-restricted account. No extra
// gating code needed: the existing enrolled-flag rendering does this for free.
//
// Idempotent: a facility is (re)used if an exact (name, lga, state) row already
// exists; otherwise a new one is inserted. Logins upsert by email (password is
// re-randomised on a rerun, matching every other provisioning script here).
//
//   node scripts/addEssentialFacilityRoster.mjs [outfile.csv]
//
// Input: the mapping workbook's underlying JSON, already extracted to the
// scratchpad by the earlier mapping pass (facility_sheets.json: {secondary:[...],
// phc:[...]}, each row {name, lga, functionality?}).

import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { pool } from '../src/db.js'

const SHEETS_JSON = process.argv[3] ||
  'C:/Users/CHRIST~1/AppData/Local/Temp/claude/C--Users-Christy-AnnieBassey-Downloads-inventory-tracker/701905a5-b9d3-4e59-8f84-4193d55c2a9d/scratchpad/facility_sheets.json'
const OUT = process.argv[2] || 'scripts/essential_facility_roster_logins.csv'
const STATE = 'Akwa Ibom'

const CANON_LGAS = [
  'Abak', 'Eastern Obolo', 'Eket', 'Esit Eket', 'Essien Udim', 'Etim Ekpo', 'Etinan',
  'Ibeno', 'Ibesikpo Asutan', 'Ibiono-Ibom', 'Ika', 'Ikono', 'Ikot Abasi', 'Ikot Ekpene',
  'Ini', 'Itu', 'Mbo', 'Mkpat-Enin', 'Nsit-Atai', 'Nsit-Ibom', 'Nsit-Ubium', 'Obot Akara',
  'Okobo', 'Onna', 'Oron', 'Oruk Anam', 'Udung-Uko', 'Ukanafun', 'Uruan',
  'Urue-Offong/Oruko', 'Uyo',
]
// The two source sheets spell LGAs with spaces (no hyphen/slash); canonicalise by
// comparing letters only, so "Mkpat Enin" -> "Mkpat-Enin", "Urue Offong Oruko" ->
// "Urue-Offong/Oruko", etc.
const lettersOnly = s => s.toLowerCase().replace(/[^a-z]/g, '')
const LGA_BY_LETTERS = new Map(CANON_LGAS.map(l => [lettersOnly(l), l]))
function canonLga(raw) {
  const key = lettersOnly(raw || '')
  return LGA_BY_LETTERS.get(key) || raw
}

// This is the one existing LGA -> cluster mapping in use (from facilityService /
// the current `facilities` rows) — kept literal rather than re-derived so it can't
// silently drift from what admin scoping already relies on.
const CLUSTER_BY_LGA = {
  Abak: 'Ikot Ekpene', 'Eastern Obolo': 'Eket', Eket: 'Eket', 'Esit Eket': 'Eket',
  'Essien Udim': 'Ikot Ekpene', 'Etim Ekpo': 'Ikot Ekpene', Etinan: 'Uyo', Ibeno: 'Eket',
  'Ibesikpo Asutan': 'Uyo', 'Ibiono-Ibom': 'Ikot Ekpene', Ika: 'Ikot Ekpene',
  Ikono: 'Ikot Ekpene', 'Ikot Abasi': 'Eket', 'Ikot Ekpene': 'Ikot Ekpene', Ini: 'Ikot Ekpene',
  Itu: 'Ikot Ekpene', Mbo: 'Uyo', 'Mkpat-Enin': 'Eket', 'Nsit-Atai': 'Uyo', 'Nsit-Ibom': 'Eket',
  'Nsit-Ubium': 'Eket', 'Obot Akara': 'Ikot Ekpene', Okobo: 'Uyo', Onna: 'Eket', Oron: 'Uyo',
  'Oruk Anam': 'Eket', 'Udung-Uko': 'Uyo', Ukanafun: 'Uyo', Uruan: 'Uyo',
  'Urue-Offong/Oruko': 'Eket', Uyo: 'Uyo',
}

// Facility-type abbreviations, longest phrase first so "primary health centre"
// matches before a bare "centre" would. Kept short and house-style-ish
// (…hc, …gh, …phc) without trying to perfectly replicate every hand-picked slug
// already in the DB — this only needs to be readable and collision-resistant.
const TYPE_ABBR = [
  [/primary health (centre|center)/, 'phc'],
  [/comprehensive health (centre|center)/, 'chc'],
  [/health (centre|center)/, 'hc'],
  [/health post/, 'hp'],
  [/general hospital/, 'gh'],
  [/cottage hospital/, 'ch'],
  [/infectious disease hospital/, 'idh'],
  [/psychiatric hospital/, 'psy'],
  [/dental (centre|center)/, 'dc'],
  [/specialist hospital/, 'sh'],
  [/hospital/, 'hosp'],
  [/clinic/, 'clinic'],
]
function slugify(name, usedSlugs) {
  let rest = name.toLowerCase()
  let abbr = ''
  for (const [re, tag] of TYPE_ABBR) {
    if (re.test(rest)) { abbr = tag; rest = rest.replace(re, ''); break }
  }
  const core = rest.replace(/[^a-z0-9]+/g, '').slice(0, 24)
  let slug = (core + abbr) || 'facility'
  let n = 2
  const base = slug
  while (usedSlugs.has(slug)) { slug = `${base}${n}`; n += 1 }
  usedSlugs.add(slug)
  return slug
}

const CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
function makePassword() {
  let pw
  do { pw = Array.from(crypto.randomBytes(12), b => CHARS[b % CHARS.length]).join('') } while (!/[2-9]/.test(pw))
  return pw
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

let codeSeq = 1
function nextCode(name) {
  const initials = name.replace(/[^A-Za-z ]/g, '').split(/\s+/).filter(Boolean).slice(0, 3).map(w => w[0]).join('').toUpperCase().padEnd(3, 'X')
  const code = `${initials}${String(codeSeq).padStart(3, '0')}`
  codeSeq += 1
  return code
}

async function ensureFacility(name, lgaRaw, level) {
  const lga = canonLga(lgaRaw)
  const cluster = CLUSTER_BY_LGA[lga] || null
  const existing = (await pool.query(
    `select id from facilities where name = $1 and lga = $2 and state = $3`, [name, lga, STATE]
  )).rows[0]
  if (existing) return { id: existing.id, lga, created: false }
  const code = nextCode(name)
  const row = (await pool.query(
    `insert into facilities (id, name, code, state, lga, cluster, level)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6) returning id`,
    [name, code, STATE, lga, cluster, level]
  )).rows[0]
  return { id: row.id, lga, created: true }
}

async function ensureEssentialModule(facilityId) {
  await pool.query(
    `insert into facility_modules (facility_id, module)
     values ($1, 'essential')
     on conflict (facility_id, module) do nothing`,
    [facilityId]
  )
}

async function ensureLogin(slug, facility, name, lga, level) {
  const email = `${slug}.essential@envo.ng`
  const password = makePassword()
  const hash = await bcrypt.hash(password, 10)
  const meta = {
    access_level: 'facility',
    facility_id: facility.id,
    facility_name: name,
    admin_state: STATE,
    facility_role: 'store_manager',
    commodity_section: 'pharmacy',
    email_verified: true,
    essential: true, // per-login grant — required on top of facility_modules enrolment
  }
  await pool.query(
    `insert into users (id, email, encrypted_password, raw_user_meta_data)
     values (gen_random_uuid(), $1, $2, $3::jsonb)
     on conflict (email) do update
       set encrypted_password = excluded.encrypted_password,
           raw_user_meta_data = excluded.raw_user_meta_data`,
    [email, hash, JSON.stringify(meta)]
  )
  return { email, password }
}

async function main() {
  const sheets = JSON.parse(fs.readFileSync(SHEETS_JSON, 'utf8'))
  const usedSlugs = new Set()
  const rows = [['username', 'password', 'facility', 'lga', 'level', 'facility_created', 'email']]

  let created = 0, reused = 0
  for (const [key, level] of [['secondary', 'secondary'], ['phc', 'phc']]) {
    for (const item of sheets[key]) {
      const facility = await ensureFacility(item.name, item.lga, level)
      await ensureEssentialModule(facility.id)
      const slug = slugify(item.name, usedSlugs)
      const { email, password } = await ensureLogin(slug, facility, item.name, facility.lga, level)
      // Login username is the FULL local part (slug + .essential), not the bare
      // slug — the login screen only appends @envo.ng, it does not add the
      // suffix. Writing the bare slug here previously meant every login typed
      // exactly as shown failed with "Invalid login credentials".
      rows.push([`${slug}.essential`, password, item.name, facility.lga, level, facility.created ? 'yes' : 'reused', email])
      if (facility.created) created += 1; else reused += 1
    }
  }

  fs.writeFileSync(OUT, rows.map(r => r.map(csvCell).join(',')).join('\r\n'))
  console.log(`Facilities created: ${created}  |  reused (already an exact name+LGA match): ${reused}`)
  console.log(`Logins created/updated: ${rows.length - 1}`)
  console.log(`Credentials written to: ${OUT}`)
  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
