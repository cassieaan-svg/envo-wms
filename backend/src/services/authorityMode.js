import { query } from '../db.js'

// WHICH AUTHORITY DECIDES — the ACL cutover's rollback flag (audit finding B-1).
//
// Reading this module does not change any decision. It answers one question,
// 'legacy' | 'shadow' | 'enforce', and middleware/authorityGate.js acts on it.
//
// PRECEDENCE. The environment variable wins over the table, and the table wins
// over the default:
//
//   ENVO_AUTH_MODE   an emergency kill switch. It is deliberately ABOVE the
//                    table, because the failure this protects against includes
//                    "the database is the problem" — a rollback that needs a
//                    healthy database to be applied is not a rollback.
//   authorization_mode.mode
//                    the normal control. One UPDATE, no restart, live within
//                    CACHE_MS across every process.
//   'legacy'         when neither is usable.
//
// EVERY FAILURE RESOLVES TO 'legacy'. A missing table (production has not had
// the ACL migrations), an unreadable row, a typo in the env var, a dead
// connection: all of them mean scope.js keeps deciding, exactly as it does
// today. There is no path that fails INTO 'enforce'. The ACL has never
// authorised a production request, so it is never the safer guess — and a flag
// whose failure mode is "switch authority to the untested thing" would be worse
// than having no flag.
//
// CACHING. The mode is read on the authorization path, so it is cached for
// CACHE_MS. That is the rollback's actual latency: a flip is live within this
// window, no restart. Five seconds is short enough to be an incident response
// and long enough that the flag costs approximately nothing per request.

const VALID = ['legacy', 'shadow', 'enforce']
const CACHE_MS = 5_000

let cache = { mode: null, until: 0 }

// The env override, or null when unset. An INVALID value is not silently
// ignored — it is reported and treated as unset, because a typo in a kill
// switch should be loud rather than quietly leaving the previous mode live.
function envMode() {
  const raw = process.env.ENVO_AUTH_MODE
  if (!raw) return null
  const mode = raw.trim().toLowerCase()
  if (VALID.includes(mode)) return mode
  console.error(
    `[authority] ENVO_AUTH_MODE="${raw}" is not one of ${VALID.join('/')} — ignoring it. ` +
    `The table (or 'legacy') decides instead.`)
  return null
}

/**
 * The authority in force. Cached; never throws; never returns anything but a
 * member of VALID.
 */
export async function currentMode() {
  const override = envMode()
  if (override) return override

  const now = Date.now()
  if (cache.mode && now < cache.until) return cache.mode

  let mode = 'legacy'
  try {
    const { rows } = await query(`select mode from authorization_mode where id = true`)
    if (rows.length && VALID.includes(rows[0].mode)) mode = rows[0].mode
    else if (rows.length) {
      console.error(`[authority] authorization_mode.mode="${rows[0].mode}" is not valid — using legacy.`)
    }
  } catch (err) {
    // Includes the table not existing, which is production's normal state until
    // the ACL migrations land. Not an error condition — the default is correct.
    if (err.code !== '42P01') {
      console.error('[authority] could not read authorization_mode, using legacy:', err.message)
    }
  }
  cache = { mode, until: now + CACHE_MS }
  return mode
}

/** True when the resolver should be computed at all. */
export const consultsAcl = mode => mode === 'shadow' || mode === 'enforce'

/**
 * Set the mode. Used by scripts/auth_mode.mjs and the tests — deliberately NOT
 * exposed through any HTTP route: this switch changes who authorises every
 * request in the system, and it should require access to the box or the
 * database, not a session that the ACL itself might have mis-scoped.
 */
export async function setMode(mode, { note = null, changedBy = 'manual' } = {}) {
  if (!VALID.includes(mode)) throw new Error(`mode must be one of ${VALID.join(', ')}`)
  await query(
    `insert into authorization_mode (id, mode, note, changed_by, changed_at)
     values (true, $1, $2, $3, now())
     on conflict (id) do update
       set mode = excluded.mode, note = excluded.note,
           changed_by = excluded.changed_by, changed_at = excluded.changed_at`,
    [mode, note, changedBy])
  invalidate()
  return mode
}

/** Drop the cache, so the next read hits the table. */
export function invalidate() { cache = { mode: null, until: 0 } }

export const MODES = VALID
export const CACHE_TTL_MS = CACHE_MS
