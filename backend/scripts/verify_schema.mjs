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
  const cols = async t => (await query(`select count(*)::int n from information_schema.columns where table_name = $1`, [t])).rows[0].n
  const nOpen = await cols('bin_opening')
  ok('table bin_opening', nOpen === 10, nOpen === 0 ? 'MISSING — migration not applied' : `${nOpen} columns (expected 10)`)

  // The bin card, audit and diagnostics all read these; without them an adjustment
  // cannot say which shelf it corrected and every one silently applies to the store.
  for (const col of ['location_type', 'site_name']) {
    const n = (await query(
      `select count(*)::int n from information_schema.columns where table_name = 'stock_adjustment_log' and column_name = $1`, [col])).rows[0].n
    ok(`stock_adjustment_log.${col}`, n === 1, n ? '' : 'MISSING — 20260805_adjustment_bin not applied')
  }

  // stock_count was the separate counting flow, now removed: corrections are
  // adjustments again. The table should be gone, not lying around to be rewired.
  const nCount = await cols('stock_count')
  ok('stock_count dropped', nCount === 0, nCount ? `still present (${nCount} columns) — apply 20260805_adjustment_bin` : 'gone')

  const c = (await query(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'stock_adjustment_log_reason_check'`)).rows[0]
  // The supported reason for a count correction, and the baseline reason used by
  // the opening-balance tooling.
  ok('reason allows "Physical count correction"', !!c && /Physical count correction/.test(c.d), c ? '' : 'constraint not found')
  ok('reason allows "Opening balance"', !!c && /Opening balance/.test(c.d), c ? '' : 'constraint not found')

  console.log('')
  console.table(checks)

  // Enforcement is a DEPLOYMENT SETTING, not a schema check — reported, never
  // gating. It used to be a check, which meant switching enforcement on made this
  // script print "1 check(s) FAILED — do NOT deploy. Apply the missing migration(s)"
  // while every schema check passed. Misleading in the one direction that matters.
  const enf = process.env.ENFORCE_BIN_STOCK
  console.log(enf === 'true'
    ? '\nENFORCE_BIN_STOCK = true — consumption and adjustments are REFUSED when they\n' +
      'would take a location below zero in EnVo. Run enforcement_readiness.mjs to see\n' +
      'which locations are affected. Remove the line from .env and restart to reverse.'
    : `\nENFORCE_BIN_STOCK ${enf == null ? 'is unset' : `= ${enf}`} — a draw beyond a location's balance is\n` +
      'still allowed (logged as a [bin-stock] warning, not blocked).')

  const failed = checks.filter(c => c.result === 'FAIL')
  if (failed.length) {
    console.log(`\n✗ ${failed.length} schema check(s) FAILED — do NOT deploy. Apply the missing migration(s) first:`)
    console.log('  node scripts/apply_migration.mjs 20260804_opening_balance_reason.sql 20260804_bin_opening.sql 20260805_adjustment_bin.sql')
    process.exitCode = 1
  } else {
    console.log('\n✓ All schema checks passed — safe to deploy.')
  }
} catch (err) {
  console.error('Verify failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
