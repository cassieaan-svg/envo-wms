// Inspect or change which authority decides authorization — the ACL cutover's
// rollback control (audit finding B-1).
//
//   node scripts/auth_mode.mjs                    show the current state
//   node scripts/auth_mode.mjs shadow "reason"    legacy decides, ACL compared
//   node scripts/auth_mode.mjs enforce "reason"   the ACL decides
//   node scripts/auth_mode.mjs legacy  "reason"   ROLL BACK
//   node scripts/auth_mode.mjs --divergence [n]   what the two disagreed about
//
// THE ROLLBACK IS: node scripts/auth_mode.mjs legacy "why"
// It takes effect within the cache TTL — no restart, no deploy. If the database
// itself is the problem, set ENVO_AUTH_MODE=legacy in backend/.env and restart;
// that overrides the table.

import { pool, query } from '../src/db.js'
import { currentMode, setMode, MODES, CACHE_TTL_MS } from '../src/services/authorityMode.js'

const [arg, note] = process.argv.slice(2)

const DESCRIPTION = {
  legacy: 'scope.js decides. The resolver is never consulted.',
  shadow: 'scope.js decides. The ACL is computed alongside and disagreements are recorded.',
  enforce: 'The ACL decides. scope.js is still computed, so rollback stays a value change.',
}

async function show() {
  const { rows } = await query(
    `select mode, note, changed_by, changed_at from authorization_mode where id = true`)
  const table = rows[0]
  const env = process.env.ENVO_AUTH_MODE
  const effective = await currentMode()

  console.log('\n  authorization authority\n  ' + '─'.repeat(58))
  console.log(`  table            ${table ? table.mode : '(no row)'}`)
  console.log(`  ENVO_AUTH_MODE   ${env || '(unset)'}${env ? '   <- overrides the table' : ''}`)
  console.log(`  EFFECTIVE        ${effective.toUpperCase()}`)
  console.log(`                   ${DESCRIPTION[effective]}`)
  if (table) {
    console.log(`\n  last change      ${table.changed_at.toISOString()} by ${table.changed_by || '?'}`)
    if (table.note) console.log(`  note             ${table.note}`)
  }
  const { rows: d } = await query(`select count(*)::int n, coalesce(sum(hits),0)::int h from authorization_divergence`)
  console.log(`\n  divergences      ${d[0].n} distinct (${d[0].h} occurrences)`)
  if (effective !== 'legacy') {
    console.log(`\n  ROLLBACK:        node scripts/auth_mode.mjs legacy "reason"`)
    console.log(`                   live within ${CACHE_TTL_MS / 1000}s, no restart`)
  }
  console.log()
}

async function divergences(limit) {
  const { rows } = await query(
    `select u.email, d.permission_key, d.legacy_allowed, d.acl_allowed,
            d.hits, d.acl_reason, d.last_seen
       from authorization_divergence d join users u on u.id = d.user_id
      order by d.hits desc, d.last_seen desc limit $1`, [limit])
  if (!rows.length) return console.log('\n  no divergences recorded\n')
  console.log(`\n  ${rows.length} divergence shape(s), widest first\n`)
  for (const r of rows) {
    // "ACL WIDER" is the one that matters: the ACL would allow something legacy
    // refuses, which the cutover gates say is never acceptable.
    const dir = r.acl_allowed && !r.legacy_allowed ? 'ACL WIDER   ' : 'ACL stricter'
    console.log(`  ${dir} ${String(r.hits).padStart(6)}x  ${r.email}  ${r.permission_key}`)
    if (r.acl_reason) console.log(`                          ${r.acl_reason}`)
  }
  console.log()
}

try {
  if (!arg) await show()
  else if (arg === '--divergence') await divergences(Number(note) || 25)
  else if (MODES.includes(arg)) {
    const from = await currentMode()
    await setMode(arg, { note: note || null, changedBy: 'auth_mode.mjs' })
    console.log(`\n  ${from} -> ${arg}`)
    console.log(`  ${DESCRIPTION[arg]}`)
    console.log(`  Live within ${CACHE_TTL_MS / 1000}s in every process.\n`)
    if (process.env.ENVO_AUTH_MODE) {
      console.error(`  WARNING: ENVO_AUTH_MODE=${process.env.ENVO_AUTH_MODE} is set and OVERRIDES this.`)
      console.error(`  The change was written but will not take effect until that is unset.\n`)
    }
  } else {
    console.error(`\n  unknown argument "${arg}" — expected one of ${MODES.join(', ')} or --divergence\n`)
    process.exitCode = 1
  }
} catch (err) {
  console.error('\n  failed:', err.message, '\n')
  process.exitCode = 1
} finally {
  await pool.end()
}
