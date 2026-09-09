import { query } from '../db.js'
import { currentMode, consultsAcl } from '../services/authorityMode.js'
import { AclResolver } from '../services/aclResolver.js'

// THE CUTOVER SWITCH (audit finding B-1).
//
// scope.js's guards each answer a question and, on denial, write a 403. This
// module wraps that pair so the ANSWER can come from either authority while the
// RESPONSE stays byte-identical, and so the choice is one value in one table
// rather than a deploy.
//
// HOW THE RESPONSE IS PRESERVED. A guard writes its own 403 with its own
// message, and there are three of them with different wording. Rather than
// refactor eighty call sites into decide-then-respond, the legacy guard is
// called with a CAPTURING stub: it "sends" into a buffer, and the buffer is
// replayed onto the real response only if the winning authority also denies.
// Nothing about the 403 a client sees changes in any mode — including the
// wording, which some tests assert on.
//
// WHY LEGACY IS COMPUTED EVEN IN `enforce`. Two reasons. It is what makes
// rollback a value change rather than a code change — the legacy path never
// stops working, so flipping back is instant. And it is what lets `enforce`
// record divergences, which is how you find out the ACL is wrong before users
// tell you.
//
// FAIL-SAFE. If the resolver throws, or cannot express the question, `enforce`
// uses the legacy answer. An authorization switch whose failure mode is "deny
// everyone" would turn an ACL bug into an outage, and one whose failure mode is
// "allow everyone" would turn it into a breach; falling back to the authority
// that has been running this system for years is neither.
//
// WHAT THIS DOES NOT COVER. Only the BOOLEAN guards. scope.js also produces
// query FILTERS — sectionFilter, scopedReadFacilityIds, resolveListFacilityIds,
// locationFacilityIds, scopedCategories — and the resolver has no list-producing
// equivalent, so those stay legacy in every mode. `enforce` is therefore a
// partial cutover: enforcement points move, list narrowing does not. That is a
// real limitation and is written down here rather than discovered later.

// Table names as scope.js knows them, to permission keys as the catalogue
// declares them. The three that differ are a naming inconsistency flagged in
// permission-catalogue.md; mapping them here is not the place to fix it, but
// getting it wrong would silently deny (an unknown key resolves to false), so
// the map is explicit and unknown tables are reported rather than guessed.
const PERMISSION_FOR_TABLE = {
  stock: 'stock',
  dsd_stock: 'dsd_stock',
  sdp_stock: 'sdp_stock',
  transfers: 'transfer',
  dispense_log: 'dispense_log',
  intake_log: 'intake_log',
  adjustment_log: 'adjustment_log',
  amc_settings: 'amc_settings',
  commodities: 'commodity',
  facilities: 'facility',
  bincard: 'bincard',
  activity: 'activity',
  edit_history: 'edit_history',
  report: 'report',
}

const reportedUnknown = new Set()
function permissionKey(table, action) {
  const resource = PERMISSION_FOR_TABLE[table]
  if (!resource) {
    // Unmapped tables are exactly the legacy fail-open documented as accepted
    // difference A-2. Returning null means "the ACL cannot express this", which
    // routes to the legacy answer rather than to a denial.
    if (!reportedUnknown.has(table)) {
      reportedUnknown.add(table)
      console.warn(`[authority] no permission key for table "${table}" — legacy decides it in every mode.`)
    }
    return null
  }
  return `${resource}.${action}`
}

// A response object that records instead of sending, so the legacy guard can be
// asked its opinion without committing to it.
function capture() {
  const buf = { status: null, body: null }
  const stub = {
    status(code) { buf.status = code; return stub },
    json(body) { buf.body = body; return stub },
    send(body) { buf.body = body; return stub },
  }
  return { stub, buf }
}

// Replay what legacy captured — or, when the denial came from the ACL and legacy
// had nothing to say, write the denial ourselves.
//
// THIS SECOND CASE IS THE WHOLE POINT OF `enforce`, and getting it wrong is
// worse than a wrong decision: the guard would return false, the route would
// `return`, and NOTHING would ever be written to the response. The client hangs
// until it times out. A denial must always produce a response, whichever
// authority originated it.
//
// The default matches scope.js's own `forbid` exactly — same status, same body
// shape, same code — so a client cannot tell which authority refused it.
function replay(res, buf, fallbackMessage) {
  if (buf.status === null && buf.body === null) {
    res.status(403).json({ success: false, error: fallbackMessage, code: 'FORBIDDEN' })
    return
  }
  const r = buf.status === null ? res : res.status(buf.status)
  if (buf.body !== null) r.json(buf.body)
}

// Divergences are aggregated by SHAPE, so a systematically wrong permission
// costs one row rather than one per request. Failure here is swallowed on
// purpose: recording a disagreement must never be able to fail a request that
// the authorities have already decided.
async function record({ userId, permissionKey: key, legacy, acl, mode, facilityId, commodityId, reason }) {
  if (!userId) return
  try {
    await query(
      `insert into authorization_divergence
         (user_id, permission_key, legacy_allowed, acl_allowed, mode, facility_id, commodity_id, acl_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (user_id, permission_key, legacy_allowed, acl_allowed) do update
         set hits = authorization_divergence.hits + 1,
             last_seen = now(),
             mode = excluded.mode,
             acl_reason = excluded.acl_reason`,
      [userId, key, legacy, acl, mode, facilityId || null, commodityId || null, reason || null])
  } catch (err) {
    if (err.code !== '42P01') console.error('[authority] divergence not recorded:', err.message)
  }
}

/**
 * Run a legacy guard under the current authority.
 *
 * `legacyCall(stubRes)` must invoke the real guard and return its boolean.
 * `aclCall()` must return { decision, reason } — or null when the ACL cannot
 * express the question, in which case legacy stands whatever the mode.
 */
async function decide(res, { legacyCall, aclCall, context, denialMessage }) {
  const mode = await currentMode()

  // The fast path: no stub, no resolver, no mode-specific behaviour at all. In
  // production today this is every request, and it is the same code path that
  // ran before this module existed.
  if (mode === 'legacy') return legacyCall(res)

  const { stub, buf } = capture()
  const legacy = await legacyCall(stub)

  let decision = legacy
  if (consultsAcl(mode)) {
    let acl = null
    try {
      acl = await aclCall()
    } catch (err) {
      console.error('[authority] resolver threw, using legacy:', err.message)
      acl = null
    }
    if (acl && acl.decision !== legacy) {
      await record({ ...context, legacy, acl: acl.decision, mode, reason: acl.reason })
    }
    if (mode === 'enforce' && acl) decision = acl.decision
  }

  if (!decision) replay(res, buf, denialMessage)
  return decision
}

/**
 * Wrap scope.js's two facility guards. `action` is 'read' or 'write'.
 */
export function gateFacility(legacyGuard, action) {
  return async function gated(req, res, facilityId, table) {
    const userId = req.user?.sub
    const key = permissionKey(table, action)
    return decide(res, {
      legacyCall: r => legacyGuard(req, r, facilityId, table),
      aclCall: () => (key && userId) ? AclResolver.can(userId, key, { facilityId }) : null,
      context: { userId, permissionKey: key, facilityId },
      denialMessage: 'Not authorized for this facility',
    })
  }
}

/**
 * Wrap the commodity-section guard. This one has no permission key — it asks
 * whether a COMMODITY is in reach, which the ACL answers with the commodity and
 * module dimensions rather than with a capability. The synthetic key names the
 * dimensions so divergence rows are still legible.
 */
export function gateCommoditySection(legacyGuard) {
  return async function gated(req, res, commodityId, category) {
    const userId = req.user?.sub
    return decide(res, {
      legacyCall: r => legacyGuard(req, r, commodityId, category),
      aclCall: async () => {
        if (!userId || !commodityId) return null
        const inCommodity = await AclResolver.commodityCovers(userId, commodityId)
        if (!inCommodity) return { decision: false, reason: 'commodity outside scope' }
        const inModule = await AclResolver.moduleCovers(userId, commodityId)
        return inModule
          ? { decision: true, reason: 'commodity and module in scope' }
          : { decision: false, reason: 'commodity outside module scope' }
      },
      context: { userId, permissionKey: 'commodity.section', commodityId },
      denialMessage: 'Not authorized for this commodity section',
    })
  }
}
