// Phase 2E — shadow comparison: legacy scope.js guards vs the new AclResolver,
// for the SAME real migrated users and the SAME resource contexts.
//
// legacyDecision always wins in the real application (this suite calls no
// route and writes no HTTP response — it only exercises the guard functions
// directly, same as every other scope.js test in this project). The point
// here is comparison, not enforcement.
//
// Per Step 18 of the phase brief: do NOT force 100% parity. Every comparison
// below is classified as either an EXPECTED MATCH (asserted equal — a
// regression here means the resolver silently drifted from legacy behavior)
// or a KNOWN, DELIBERATE MISMATCH (asserted to REMAIN a mismatch — a
// regression here would mean the resolver quietly grew a legacy special case
// it should not yet have, or a real legacy bug got reproduced instead of
// surfaced). Each mismatch names its category from the phase brief:
//   A. ACL implementation bug   D. Scope model gap
//   B. Incorrect migration data E. Legacy special-case behavior
//   C. Permission catalogue gap F. Existing legacy authorization bug
//
// TEST ISOLATION: every user used below is a REAL migrated user, read-only —
// no role assignment is created, modified, or deleted by this suite.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import {
  enforceFacilityRead, enforceFacilityWrite,
  enforceTransferAccess, mayWriteTransfer, enforceCommoditySection,
} from '../src/middleware/scope.js'
import { AclResolver } from '../src/services/aclResolver.js'
import { scopeFor, verdict } from './helpers/legacyHarness.js'

test.after(async () => { await pool.end() })

// A real user's raw_user_meta_data plus a resolvable facility/state/etc. — read
// only, matches the resolver tests' own helper for consistency.
async function realUser(roleName) {
  // overall_admin's scope_id is LEGITIMATELY '' (Phase 2D) — the empty-scope
  // requirement below only makes sense for the other five roles, whose scope
  // is a real facility/state/cluster/LGA identifier.
  const scopeCond = roleName === 'overall_admin' ? '' : `and ur.scope_id <> ''`
  const { rows } = await query(
    `select u.id, u.raw_user_meta_data meta, ur.scope_type, ur.scope_id
       from user_roles ur join roles r on r.id=ur.role_id join users u on u.id=ur.user_id
      where r.name = $1 and u.email not like '%.invalid' and u.email not like 'probe.create.%' ${scopeCond}
      limit 1`, [roleName])
  if (!rows.length) throw new Error(`no real user with role ${roleName}`)
  return rows[0]
}

// A real commodity in `meta`'s own section (or any, if the account isn't
// section-pinned) — so a transfer-scope comparison isolates facility-party
// scope from the SEPARATE section gate enforceTransferAccess also applies
// inline (see the header comment on the transfer tests below).
async function commodityInOwnSection(meta) {
  const section = meta.commodity_section
  const catByRow = { pharmacy: ['Pharmacy drugs'], lab: ['RTKs', 'Lab reagents', 'Lab consumables'] }
  const cats = catByRow[section]
  const { rows } = await query(
    cats ? `select id, category, name from commodities where category = any($1) limit 1`
         : `select id, category, name from commodities limit 1`,
    cats ? [cats] : [])
  return rows[0]
}

let COMPARISONS = 0, MATCHES = 0
function record(label, legacy, acl, expectMatch, category) {
  COMPARISONS++
  const matched = legacy === acl
  if (matched) MATCHES++
  const outcome = matched ? 'MATCH' : `MISMATCH (${category})`
  assert.equal(matched, expectMatch,
    `${label}: legacy=${legacy} acl=${acl} — expected ${expectMatch ? 'a match' : 'a ' + category + ' mismatch'}, got ${outcome}`)
}

test.after(() => {
  console.log(`\n[shadow comparison] ${MATCHES}/${COMPARISONS} matched, ${COMPARISONS - MATCHES} known mismatch(es)\n`)
})

// ═════════════════════════════════════════════════════════════════════════════
// Facility
// ═════════════════════════════════════════════════════════════════════════════

test('facility: own-facility read matches', async () => {
  const u = await realUser('facility')
  const req = scopeFor(u.meta)
  const legacy = await verdict(res => enforceFacilityRead(req, res, u.scope_id, 'stock'))
  const acl = (await AclResolver.can(u.id, 'stock.read', { facilityId: u.scope_id })).decision
  record('facility own read', legacy, acl, true)
})

test('facility: own-facility write matches', async () => {
  const u = await realUser('facility')
  const req = scopeFor(u.meta)
  const legacy = await verdict(res => enforceFacilityWrite(req, res, u.scope_id, 'stock'))
  const acl = (await AclResolver.can(u.id, 'stock.write', { facilityId: u.scope_id })).decision
  record('facility own write', legacy, acl, true)
})

test('facility: another facility (read and write) both deny — matches', async () => {
  const u = await realUser('facility')
  const { rows } = await query(`select id from facilities where id <> $1 limit 1`, [u.scope_id])
  const other = rows[0].id
  const req = scopeFor(u.meta)
  const legacyRead = await verdict(res => enforceFacilityRead(req, res, other, 'stock'))
  const aclRead = (await AclResolver.can(u.id, 'stock.read', { facilityId: other })).decision
  record('facility other read', legacyRead, aclRead, true)
  const legacyWrite = await verdict(res => enforceFacilityWrite(req, res, other, 'stock'))
  const aclWrite = (await AclResolver.can(u.id, 'stock.write', { facilityId: other })).decision
  record('facility other write', legacyWrite, aclWrite, true)
})

// ═════════════════════════════════════════════════════════════════════════════
// State admin
// ═════════════════════════════════════════════════════════════════════════════

test('state_admin: own-state read and write match', async () => {
  const u = await realUser('state_admin')
  const { rows } = await query(`select id from facilities where state = $1 limit 1`, [u.scope_id])
  const fac = rows[0].id
  const req = scopeFor(u.meta)
  const legacyRead = await verdict(res => enforceFacilityRead(req, res, fac, 'stock'))
  const aclRead = (await AclResolver.can(u.id, 'stock.read', { facilityId: fac })).decision
  record('state_admin in-state read', legacyRead, aclRead, true)
  const legacyWrite = await verdict(res => enforceFacilityWrite(req, res, fac, 'stock'))
  const aclWrite = (await AclResolver.can(u.id, 'stock.write', { facilityId: fac })).decision
  record('state_admin in-state write', legacyWrite, aclWrite, true)
})

test('state_admin: cross-facility write where currently allowed (stock) matches', async () => {
  const u = await realUser('state_admin')
  const { rows } = await query(`select id from facilities where state = $1 offset 1 limit 1`, [u.scope_id])
  const anotherFacilityInState = rows[0].id
  const req = scopeFor(u.meta)
  const legacy = await verdict(res => enforceFacilityWrite(req, res, anotherFacilityInState, 'stock'))
  const acl = (await AclResolver.can(u.id, 'stock.write', { facilityId: anotherFacilityInState })).decision
  record('state_admin cross-facility stock.write', legacy, acl, true)
})

test('state_admin: another state (read and write) both deny — matches', async () => {
  const u = await realUser('state_admin')
  const { rows } = await query(`select id from facilities where state <> $1 limit 1`, [u.scope_id])
  const other = rows[0].id
  const req = scopeFor(u.meta)
  const legacyRead = await verdict(res => enforceFacilityRead(req, res, other, 'stock'))
  const aclRead = (await AclResolver.can(u.id, 'stock.read', { facilityId: other })).decision
  record('state_admin other-state read', legacyRead, aclRead, true)
  const legacyWrite = await verdict(res => enforceFacilityWrite(req, res, other, 'stock'))
  const aclWrite = (await AclResolver.can(u.id, 'stock.write', { facilityId: other })).decision
  record('state_admin other-state write', legacyWrite, aclWrite, true)
})

// ═════════════════════════════════════════════════════════════════════════════
// State viewer / cluster admin / LGA admin — read matches, write matches (both deny)
// ═════════════════════════════════════════════════════════════════════════════

test('state_viewer: own-state read matches; write attempt matches (both deny)', async () => {
  const u = await realUser('state_viewer')
  const { rows } = await query(`select id from facilities where state = $1 limit 1`, [u.scope_id])
  const fac = rows[0].id
  const req = scopeFor(u.meta)
  record('state_viewer own read',
    await verdict(res => enforceFacilityRead(req, res, fac, 'stock')),
    (await AclResolver.can(u.id, 'stock.read', { facilityId: fac })).decision, true)
  record('state_viewer write attempt',
    await verdict(res => enforceFacilityWrite(req, res, fac, 'stock')),
    (await AclResolver.can(u.id, 'stock.write', { facilityId: fac })).decision, true)
})

test('cluster_admin: own-cluster read matches; outside-cluster read matches; write attempt matches', async () => {
  const u = await realUser('cluster_admin')
  const { rows: inC } = await query(`select id from facilities where cluster = $1 limit 1`, [u.scope_id])
  const { rows: outC } = await query(`select id from facilities where cluster is distinct from $1 limit 1`, [u.scope_id])
  const req = scopeFor(u.meta)
  record('cluster_admin own-cluster read',
    await verdict(res => enforceFacilityRead(req, res, inC[0].id, 'stock')),
    (await AclResolver.can(u.id, 'stock.read', { facilityId: inC[0].id })).decision, true)
  record('cluster_admin outside-cluster read',
    await verdict(res => enforceFacilityRead(req, res, outC[0].id, 'stock')),
    (await AclResolver.can(u.id, 'stock.read', { facilityId: outC[0].id })).decision, true)
  record('cluster_admin write attempt',
    await verdict(res => enforceFacilityWrite(req, res, inC[0].id, 'stock')),
    (await AclResolver.can(u.id, 'stock.write', { facilityId: inC[0].id })).decision, true)
})

test('lga_admin: own-LGA read matches; outside-LGA read matches; write attempt matches', async () => {
  const u = await realUser('lga_admin')
  const { rows: inL } = await query(`select id from facilities where lga = $1 limit 1`, [u.scope_id])
  const { rows: outL } = await query(`select id from facilities where lga is distinct from $1 limit 1`, [u.scope_id])
  const req = scopeFor(u.meta)
  record('lga_admin own-LGA read',
    await verdict(res => enforceFacilityRead(req, res, inL[0].id, 'stock')),
    (await AclResolver.can(u.id, 'stock.read', { facilityId: inL[0].id })).decision, true)
  record('lga_admin outside-LGA read',
    await verdict(res => enforceFacilityRead(req, res, outL[0].id, 'stock')),
    (await AclResolver.can(u.id, 'stock.read', { facilityId: outL[0].id })).decision, true)
  record('lga_admin write attempt',
    await verdict(res => enforceFacilityWrite(req, res, inL[0].id, 'stock')),
    (await AclResolver.can(u.id, 'stock.write', { facilityId: inL[0].id })).decision, true)
})

// ═════════════════════════════════════════════════════════════════════════════
// Overall admin
// ═════════════════════════════════════════════════════════════════════════════

test('overall_admin: national read matches; write attempt matches (both deny, by design)', async () => {
  const u = await realUser('overall_admin')
  const { rows } = await query(`select id from facilities order by random() limit 1`)
  const req = scopeFor(u.meta)
  record('overall_admin national read',
    await verdict(res => enforceFacilityRead(req, res, rows[0].id, 'stock')),
    (await AclResolver.can(u.id, 'stock.read', { facilityId: rows[0].id })).decision, true)
  record('overall_admin write attempt',
    await verdict(res => enforceFacilityWrite(req, res, rows[0].id, 'stock')),
    (await AclResolver.can(u.id, 'stock.write', { facilityId: rows[0].id })).decision, true)
})

// ═════════════════════════════════════════════════════════════════════════════
// Transfer — its own authorization path, not ordinary stock scope
// ═════════════════════════════════════════════════════════════════════════════

test('transfer: a facility party matches on both read and write', async () => {
  // enforceTransferAccess/mayWriteTransfer apply the section gate INLINE (unlike
  // stock, whose section gate is the separate enforceCommoditySection call) — a
  // transfer whose commodity sits outside the caller's section is refused for
  // that reason alone, independent of facility-party scope. Supplying a
  // commodity within the user's own section isolates the thing this test
  // actually claims to compare.
  const u = await realUser('facility')
  const { rows } = await query(`select id from facilities where id <> $1 limit 1`, [u.scope_id])
  const other = rows[0].id
  const commodity = await commodityInOwnSection(u.meta)
  const transfer = { sending_facility_id: u.scope_id, receiving_facility_id: other, commodities: commodity }
  const req = scopeFor(u.meta)
  const legacyRead = await verdict(res => enforceTransferAccess(req, res, transfer))
  const aclRead = (await AclResolver.can(u.id, 'transfer.read',
    { sendingFacilityId: u.scope_id, receivingFacilityId: other })).decision
  record('transfer facility-party read', legacyRead, aclRead, true)

  const legacyWrite = await mayWriteTransfer(req, transfer)
  const aclWrite = (await AclResolver.can(u.id, 'transfer.write',
    { sendingFacilityId: u.scope_id, receivingFacilityId: other })).decision
  record('transfer facility-party write', legacyWrite, aclWrite, true)
})

test('transfer: state_admin cross-facility write (either party in-state) matches', async () => {
  const u = await realUser('state_admin')
  const { rows } = await query(`select id from facilities where state = $1 limit 2`, [u.scope_id])
  const transfer = { sending_facility_id: rows[0].id, receiving_facility_id: rows[1].id, commodities: {} }
  const req = scopeFor(u.meta)
  const legacy = await mayWriteTransfer(req, transfer)
  const acl = (await AclResolver.can(u.id, 'transfer.write',
    { sendingFacilityId: rows[0].id, receivingFacilityId: rows[1].id })).decision
  record('transfer state_admin cross-facility write', legacy, acl, true)
})

// ═════════════════════════════════════════════════════════════════════════════
// KNOWN, DELIBERATE MISMATCHES — Step 13/18: the resolver must NOT silently
// absorb these. Each assertion below expects legacy !== acl and stays failing
// RED if a future change accidentally makes them agree by reproducing the
// legacy behavior into the resolver (which Step 13 explicitly forbids) or by
// the resolver quietly growing the special case.
// ═════════════════════════════════════════════════════════════════════════════

test('MISMATCH (E — legacy special case): pending-transfer counterparty stock.read', async () => {
  // Legacy: a facility user may read a COUNTERPARTY facility's stock while a
  // transfer between them is 'pending' (scope.js:129-142). The ACL resolver has
  // no concept of "another facility's pending transfer" at all — it only knows
  // the role's assigned scope. This is a real, currently-unrepresentable
  // legacy behavior, not a bug to fix here.
  const u = await realUser('facility')
  const { rows: other } = await query(`select id from facilities where id <> $1 limit 1`, [u.scope_id])
  const counterpartyId = other[0].id
  await query(`insert into stock_transfer_log
      (sending_facility_id, sending_facility_name, receiving_facility_id, receiving_facility_name,
       commodity_id, commodity_name, quantity, status, initiated_at)
    select $1, 'test', $2, 'test', c.id, c.name, 1, 'pending', now()
      from commodities c limit 1 returning id`,
    [counterpartyId, u.scope_id])
  try {
    const req = scopeFor(u.meta)
    const legacy = await verdict(res => enforceFacilityRead(req, res, counterpartyId, 'stock'))
    const acl = (await AclResolver.can(u.id, 'stock.read', { facilityId: counterpartyId })).decision
    record('pending-transfer counterparty stock.read', legacy, acl, false, 'E: legacy special case (not modeled)')
    assert.equal(legacy, true, 'legacy must allow — this is the behavior being surfaced, not disputed')
    assert.equal(acl, false, 'ACL resolver correctly has no notion of this — expected, not a bug')
  } finally {
    await query(`delete from stock_transfer_log where sending_facility_id = $1 and receiving_facility_id = $2 and status='pending'`,
      [counterpartyId, u.scope_id])
  }
})

test('MISMATCH (E — legacy special case, D — scope model gap): commodity-section scope', async () => {
  // Legacy: enforceCommoditySection denies a pharmacy-sectioned user access to
  // a lab-category commodity, independent of facility scope. The ACL model has
  // NO representation of commodity_section/category anywhere — permissions and
  // user_roles carry no such dimension. A facility+permission check alone
  // (what the resolver can express) says nothing about section, so comparing
  // "would the ACL model deny this lab commodity to a pharmacy user" has no
  // answer — the honest finding is that the dimension is entirely absent, not
  // that the resolver actively agrees or disagrees.
  const u = await realUser('facility')
  // Force a pharmacy section on a copy of this user's metadata for the check —
  // read-only comparison, the real user's row is never touched.
  const pharmacyMeta = { ...u.meta, commodity_section: 'pharmacy' }
  const { rows: labCommodity } = await query(`select id from commodities where category = 'RTKs' limit 1`)
  if (!labCommodity.length) return // no RTKs seeded in this database; nothing to compare
  const req = scopeFor(pharmacyMeta)
  const legacyDeniesSection = !(await verdict(res => enforceCommoditySection(req, res, labCommodity[0].id)))
  assert.equal(legacyDeniesSection, true,
    'legacy must deny a pharmacy user a lab commodity — the behavior this finding is about')
  // No resolver call is made here on purpose: AclResolver has no
  // commodity/category parameter to pass. The absence of an equivalent call IS
  // the discrepancy record for this dimension. See the Phase 2E report.
})

test('MISMATCH (F — existing legacy bug, NOT reproduced): unmapped-table facility write', async () => {
  // Legacy: enforceFacilityWrite grants a facility user's OWN facility write
  // access for literally any table string, including one absent from
  // WRITE_ADMIN_LEVELS entirely — a documented defect (permission-catalogue.md
  // Section 6). The ACL resolver correctly denies an unknown permission key.
  // This mismatch must stay a mismatch: "fixing" it by making the resolver
  // grant on an unknown key would be reproducing a known bug, exactly what
  // Step 18 forbids for category F.
  const u = await realUser('facility')
  const req = scopeFor(u.meta)
  const legacy = await verdict(res => enforceFacilityWrite(req, res, u.scope_id, 'some_table_nobody_declared'))
  const acl = (await AclResolver.can(u.id, 'some_table_nobody_declared.write', { facilityId: u.scope_id })).decision
  record('unmapped-table facility write', legacy, acl, false, 'F: existing legacy bug (fail-open) — do not reproduce')
  assert.equal(legacy, true, 'legacy fail-open confirmed present')
  assert.equal(acl, false, 'ACL resolver correctly denies an undeclared permission key')
})
