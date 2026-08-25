// Deploy preflight: prove the code about to go live can actually talk to THIS
// database, before anything is published or restarted.
//
// The failure this exists to prevent: a commit adds a column or table (via a
// db/migrations/*.sql file), the migration is never applied to prod, and the deploy
// ships code that selects something that isn't there. Migrations never auto-run here,
// so that gap is one forgotten step wide.
//
// It is not hypothetical. The Essential Commodities work selects commodities.module,
// .unit_price, .wms_commodity_id and joins facility_modules. Deploying it without
// 20260801_modules.sql would 500 /api/commodities and /api/facilities — and because
// the session bootstrap awaits both with no catch, EVERY user is locked out at the
// login screen, not just the ones using the new feature.
//
// The check is deliberately behavioural, not a hardcoded list of expected columns:
// it CALLS the services the login path calls. Anything a future commit adds is
// covered automatically, with no need to remember to update this file.
//
//   node scripts/preflight.mjs     # exit 0 = safe to deploy, non-zero = abort
//
// Read-only. Runs no DDL and writes nothing.

import { pool } from '../src/db.js'
import { CommodityService } from '../src/services/commodityService.js'
import { FacilityService } from '../src/services/facilityService.js'
import { AmcSettingsService } from '../src/services/amcSettingsService.js'

// The three calls frontend/src/utils/session.js makes in a single Promise.all before
// it will render anything. If any one throws, nobody can sign in.
const checks = [
  ['commodities catalogue (/api/commodities)', () => CommodityService.getCommodities()],
  ['facility list (/api/facilities)',          () => FacilityService.getFacilities({})],
  ['AMC settings (/api/amc-settings)',         () => AmcSettingsService.getAmcSettings({})],
]

let failed = 0

for (const [label, run] of checks) {
  try {
    const rows = await run()
    console.log(`  ok    ${label} — ${Array.isArray(rows) ? rows.length : '?'} rows`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}`)
    console.error(`        ${err.message}`)
  }
}

await pool.end()

if (failed) {
  console.error('')
  console.error(`preflight FAILED (${failed} of ${checks.length}).`)
  console.error('The code being deployed does not match this database.')
  console.error('Almost always: a db/migrations/*.sql file has not been applied here.')
  console.error('Apply the outstanding migration(s), then re-run the deploy.')
  process.exit(1)
}

console.log('preflight ok — the login path works against this database.')
