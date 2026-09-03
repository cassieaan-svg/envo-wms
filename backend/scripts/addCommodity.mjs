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
  const existing = (await pool.query(
    `select id, category, unit, module from commodities where name = $1`, [NAME])).rows[0]

  if (DRY) {
    console.log(existing
      ? `Would UPDATE "${NAME}": ${existing.category}/${existing.unit} (module ${existing.module}) -> ${CATEGORY}/${UNIT} (module ${MODULE})`
      : `Would CREATE "${NAME}": ${CATEGORY} / ${UNIT} / module ${MODULE}`)
    await pool.end(); return
  }

  if (existing) {
    await pool.query(
      `update commodities set category = $2, unit = $3, module = $4 where id = $1`,
      [existing.id, CATEGORY, UNIT, MODULE])
    console.log(`Updated "${NAME}" (${existing.id}): ${CATEGORY} / ${UNIT} / module ${MODULE}`)
  } else {
    const { rows: [c] } = await pool.query(
      `insert into commodities (id, name, category, unit, module)
       values (gen_random_uuid(), $1, $2, $3, $4) returning id`,
      [NAME, CATEGORY, UNIT, MODULE])
    console.log(`Created "${NAME}" (${c.id}): ${CATEGORY} / ${UNIT} / module ${MODULE}`)
  }
  await pool.end()
}
