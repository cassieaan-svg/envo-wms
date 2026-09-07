// Add one commodity to the catalogue. Idempotent: matched by exact name, so
// re-running updates category/unit rather than creating a duplicate.
//
//   node scripts/addCommodity.mjs --name "Methylated Spirit (200ml)" \
//                                 --category "Lab consumables" --unit bottle [--dry-run]
//
// `module` defaults to 'hiv' (the section-scoped catalogue this app's
// SECTION_CATEGORIES / STATE_OFFICE_CATEGORIES filter against) — the commodities
// table is shared with the separate Essential Commodities / WMS catalogue, whose
// rows carry module='essential' and a wms_commodity_id. Leave module alone unless
// you are deliberately adding to that other catalogue.
//
// commodities.module comes from db/migrations/20260801_modules.sql, which belongs to
// the essential-commodities branch and is NOT on main — so it does not exist on
// production. Detected at runtime and simply omitted where absent, the same way
// 20260825_add_commodities.sql already has to for this exact reason: naming a column
// that isn't there aborts the whole statement, not just that one field.

import { pool } from '../src/db.js'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const NAME     = flag('name')
const CATEGORY = flag('category')
const UNIT     = flag('unit')
const MODULE   = flag('module') || 'hiv'
const DRY      = argv.includes('--dry-run')

if (!NAME || !CATEGORY || !UNIT) {
  console.error('Usage: node scripts/addCommodity.mjs --name "<name>" --category "<category>" --unit <unit> [--module hiv] [--dry-run]')
  process.exitCode = 1
} else {
  main()
}

async function main() {
  const hasModule = (await pool.query(
    `select 1 from information_schema.columns
     where table_name = 'commodities' and column_name = 'module'`)).rowCount > 0

  const cols = hasModule ? 'id, category, unit, module' : 'id, category, unit'
  const existing = (await pool.query(
    `select ${cols} from commodities where name = $1`, [NAME])).rows[0]

  const moduleNote = hasModule ? ` / module ${MODULE}` : ' (no module column on this database)'

  if (DRY) {
    console.log(existing
      ? `Would UPDATE "${NAME}": ${existing.category}/${existing.unit}${hasModule ? ` (module ${existing.module})` : ''} -> ${CATEGORY}/${UNIT}${moduleNote}`
      : `Would CREATE "${NAME}": ${CATEGORY} / ${UNIT}${moduleNote}`)
    await pool.end(); return
  }

  if (existing) {
    const setModule = hasModule ? ', module = $4' : ''
    const params = hasModule ? [existing.id, CATEGORY, UNIT, MODULE] : [existing.id, CATEGORY, UNIT]
    await pool.query(`update commodities set category = $2, unit = $3${setModule} where id = $1`, params)
    console.log(`Updated "${NAME}" (${existing.id}): ${CATEGORY} / ${UNIT}${moduleNote}`)
  } else {
    const insertCols = hasModule ? '(id, name, category, unit, module)' : '(id, name, category, unit)'
    const values = hasModule ? '(gen_random_uuid(), $1, $2, $3, $4)' : '(gen_random_uuid(), $1, $2, $3)'
    const params = hasModule ? [NAME, CATEGORY, UNIT, MODULE] : [NAME, CATEGORY, UNIT]
    const { rows: [c] } = await pool.query(
      `insert into commodities ${insertCols} values ${values} returning id`, params)
    console.log(`Created "${NAME}" (${c.id}): ${CATEGORY} / ${UNIT}${moduleNote}`)
  }
  await pool.end()
}
