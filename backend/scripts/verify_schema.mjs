// Pre-deploy schema check: confirms the migrations this release depends on are
// actually applied, BEFORE the code that needs them goes live.
//
// Matters because migrations never auto-run here, and the bin card read path now
// queries bin_opening — deploying without it would error every bin card. Exists as
// a script rather than a `node -e` one-liner because PowerShell strips the inner
// quotes of a long -e argument before node sees it.
//
//   cd C:\envo\app\backend
//   node scripts/verify_schema.mjs
//
// Exit code 0 = safe to deploy, 1 = do not deploy.

import { pool, query } from '../src/db.js'

const checks = []
const ok = (label, pass, detail = '') => { checks.push({ check: label, result: pass ? 'PASS' : 'FAIL', detail }) ; return pass }

try {
  // Tables + their column counts (a partially applied migration shows up here).
  for (const [t, want] of [['stock_count', 14], ['bin_opening', 10]]) {
    const n = (await query(`select count(*)::int n from information_schema.columns where table_name = $1`, [t])).rows[0].n
    ok(`table ${t}`, n === want, n === 0 ? 'MISSING — migration not applied' : `${n} columns (expected ${want})`)
  }

  // The derived stock-count adjustment cannot be written without this.
  const c = (await query(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'stock_adjustment_log_reason_check'`)).rows[0]
  ok('reason allows "Stock count variance"', !!c && /Stock count variance/.test(c.d), c ? '' : 'constraint not found')
  ok('reason allows "Opening balance"', !!c && /Opening balance/.test(c.d), c ? '' : 'constraint not found')

  // Historical rows still carry the retired reason; dropping it would fail validation.
  ok('reason still allows "Physical count correction" (historical rows)', !!c && /Physical count correction/.test(c.d))

  // Enforcement is opt-in; anything other than 'true' leaves consumption unchanged.
  const enf = process.env.ENFORCE_BIN_STOCK
  ok('ENFORCE_BIN_STOCK is off', enf !== 'true', enf == null ? 'unset (consumption unchanged)' : `= ${enf}`)

  console.log('')
  console.table(checks)
  const failed = checks.filter(c => c.result === 'FAIL')
  if (failed.length) {
    console.log(`\n✗ ${failed.length} check(s) FAILED — do NOT deploy. Apply the missing migration first:`)
    console.log('  node scripts/apply_migration.mjs 20260804_stock_count.sql 20260804_opening_balance_reason.sql 20260804_bin_opening.sql')
    process.exitCode = 1
  } else {
    console.log('\n✓ All checks passed — safe to deploy.')
  }
} catch (err) {
  console.error('Verify failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
