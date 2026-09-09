// role_permissions.scope_mode — per-grant scope narrowing.
//
// Legacy WRITE_ADMIN_LEVELS gives state_admin cross-facility write on stock and
// friends, but maps dispense_log/intake_log/adjustment_log to an EMPTY array:
// no role writes those outside its own facility. The resolver used to mirror
// that with a code constant; scope_mode now carries it as data.
//
// Shadow-only — scope.js remains authoritative and nothing here touches the
// request path.
//
// SAFETY: the two tests that need an unusual scope_mode change one row and
// restore it in `finally`. Everything else is read-only against real seeded
// data. A final test asserts the table is back to its expected shape.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import { AclResolver } from '../src/services/aclResolver.js'

test.after(async () => { await pool.end() })

// Facilities this suite writes feature_config rows for, so the final
// "left nothing behind" check can scope itself to its own work.
const touchedFacilities = []

const OWN_FACILITY_ONLY = ['dispense_log.write', 'intake_log.write', 'adjustment_log.write']
const CROSS_FACILITY_OK = ['stock.write', 'dsd_stock.write', 'sdp_stock.write', 'amc_settings.write']

async function realUser(roleName) {
  const scopeCond = roleName === 'overall_admin' ? '' : `and ur.scope_id <> ''`
  const { rows } = await query(
    `select u.id, ur.scope_type, ur.scope_id
       from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
      where r.name = $1 and u.email not like '%.invalid' and u.email not like 'probe.create.%' ${scopeCond} limit 1`, [roleName])
  if (!rows.length) throw new Error(`no real user with role ${roleName}`)
  return rows[0]
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The data mirrors WRITE_ADMIN_LEVELS
// ═════════════════════════════════════════════════════════════════════════════

test('exactly the three log writes are own_facility_only; everything else inherits', async () => {
  const { rows } = await query(
    `select distinct permission_key from role_permissions
      where scope_mode = 'own_facility_only' order by 1`)
  assert.deepEqual(rows.map(r => r.permission_key), [...OWN_FACILITY_ONLY].sort())
})

test('the narrowing applies to every role holding those permissions, not just state_admin', async () => {
  // The legacy rule is a property of the TABLE (dispense_log: []), not of one
  // role — so recording it only against state_admin would be a half-truth.
  const { rows } = await query(
    `select r.name, count(*)::int n from role_permissions rp
       join roles r on r.id = rp.role_id
      where rp.scope_mode = 'own_facility_only' group by 1 order by 1`)
  assert.deepEqual(rows, [
    // essential_admin (Phase 2M) copied state_admin's grants FROM THE DATA, which
    // is why it carries the narrowing too — re-listing the keys by hand there
    // would have silently dropped it.
    { name: 'essential_admin', n: 3 },
    { name: 'facility', n: 3 },
    { name: 'state_admin', n: 3 },
  ])
})

test('scope_mode defaults to inherit, preserving existing behaviour', async () => {
  const { rows } = await query(
    `select count(*)::int n from role_permissions where scope_mode = 'inherit'`)
  assert.equal(rows[0].n, 129, 'every other grant is untouched (101 + 28 added by Phase 2M)')
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. state_admin cross-facility access where the matrix allows it
// ═════════════════════════════════════════════════════════════════════════════

test('state_admin keeps cross-facility write on stock and friends', async () => {
  const u = await realUser('state_admin')
  const { rows } = await query(
    `select id from facilities where state = $1 offset 1 limit 1`, [u.scope_id])
  const otherInState = rows[0].id
  for (const key of CROSS_FACILITY_OK) {
    const res = await AclResolver.can(u.id, key, { facilityId: otherInState })
    assert.equal(res.decision, true, `${key} must still reach another facility in-state`)
  }
})

test('state_admin still cannot reach outside its state', async () => {
  const u = await realUser('state_admin')
  const { rows } = await query(`select id from facilities where state <> $1 limit 1`, [u.scope_id])
  const res = await AclResolver.can(u.id, 'stock.write', { facilityId: rows[0].id })
  assert.equal(res.decision, false, 'scope_mode must not widen anything')
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. own_facility_only writes
// ═════════════════════════════════════════════════════════════════════════════

test('state_admin is denied the log writes even inside its own state', async () => {
  const u = await realUser('state_admin')
  const { rows } = await query(`select id from facilities where state = $1 limit 1`, [u.scope_id])
  for (const key of OWN_FACILITY_ONLY) {
    const res = await AclResolver.can(u.id, key, { facilityId: rows[0].id })
    assert.equal(res.decision, false, `${key} must not widen across facilities`)
    assert.match(res.reason, /own-facility-only/)
  }
})

test('a facility user keeps the log writes at its OWN facility', async () => {
  const u = await realUser('facility')
  for (const key of OWN_FACILITY_ONLY) {
    const res = await AclResolver.can(u.id, key, { facilityId: u.scope_id })
    assert.equal(res.decision, true, `${key} must still work at the actor's own facility`)
  }
})

test('a facility user is denied the log writes at another facility', async () => {
  const u = await realUser('facility')
  const { rows } = await query(`select id from facilities where id <> $1 limit 1`, [u.scope_id])
  const res = await AclResolver.can(u.id, 'dispense_log.write', { facilityId: rows[0].id })
  assert.equal(res.decision, false)
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Fail closed
// ═════════════════════════════════════════════════════════════════════════════

test('missing facility in the request context fails closed', async () => {
  const u = await realUser('facility')
  for (const key of [...OWN_FACILITY_ONLY, 'stock.write']) {
    const res = await AclResolver.can(u.id, key, {}) // no facilityId at all
    assert.equal(res.decision, false, `${key} must deny when no facility is named`)
  }
})

test('an unknown scope_mode fails closed rather than being treated as permissive', async () => {
  // The CHECK constraint makes an unrecognised value unreachable through normal
  // writes, so it has to be forced somehow to prove the resolver does not fall
  // through to "allow" on a value it does not understand.
  //
  // IT IS FORCED IN MEMORY, NOT IN THE DATABASE. The earlier version of this
  // test dropped the CHECK constraint and wrote a garbage scope_mode onto the
  // shared facility/stock.write grant. `node --test` runs test FILES
  // concurrently against this one database, so for the width of that window
  // every other suite saw a corrupted authorization rule —
  // aclShadowComparison read it and reported a false mismatch roughly one run
  // in twenty.
  //
  // Stubbing the lookup instead is both safer and a tighter test: it isolates
  // the single behaviour under scrutiny — what `can()` does with a scope_mode it
  // does not recognise — without asserting anything about how such a value could
  // come to exist. `node --test` gives each file its own process, so the stub is
  // invisible outside this one, and no shared state is touched at all.
  //
  // The database's own refusal to store such a value is covered by the next
  // test, which relies on the constraint being intact rather than removing it.
  const u = await realUser('facility')

  const original = AclResolver.getScopeMode
  // Narrow on purpose: only the pair under test is faked, so anything else the
  // resolver looks up on the way to the decision still comes from real data.
  AclResolver.getScopeMode = async function (roleName, permissionKey) {
    if (roleName === 'facility' && permissionKey === 'stock.write') return 'something_unrecognised'
    return original.call(this, roleName, permissionKey)
  }
  try {
    const res = await AclResolver.can(u.id, 'stock.write', { facilityId: u.scope_id })
    assert.equal(res.decision, false, 'an unrecognised scope_mode must never allow')
    assert.match(res.reason, /unrecognised scope_mode/)
  } finally {
    AclResolver.getScopeMode = original
  }

  // The stub is gone and the real grant was never touched: the same call must
  // now be allowed again. Without this, a restore that silently failed would
  // leave every later test in this file passing for the wrong reason.
  const after = await AclResolver.can(u.id, 'stock.write', { facilityId: u.scope_id })
  assert.equal(after.decision, true, 'the real facility/stock.write grant is untouched')
})

test('the database rejects an unknown scope_mode outright', async () => {
  const { rows: role } = await query(`select id from roles where name = 'facility'`)
  await assert.rejects(
    () => query(`update role_permissions set scope_mode = 'nonsense'
                  where role_id = $1 and permission_key = 'stock.write'`, [role[0].id]),
    err => err.code === '23514')
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. scope_mode does not grant anything on its own
// ═════════════════════════════════════════════════════════════════════════════

test('a role without the permission is still denied, whatever its scope_mode', async () => {
  const u = await realUser('state_viewer')
  const { rows } = await query(`select id from facilities where state = $1 limit 1`, [u.scope_id])
  for (const key of [...OWN_FACILITY_ONLY, 'stock.write']) {
    const res = await AclResolver.can(u.id, key, { facilityId: rows[0].id })
    assert.equal(res.decision, false)
    assert.equal(res.reason, 'role lacks permission', `${key}: denied by capability, before scope_mode`)
  }
})

test('overall_admin gains no write from scope_mode — it holds none', async () => {
  const u = await realUser('overall_admin')
  const { rows } = await query(`select id from facilities limit 1`)
  const res = await AclResolver.can(u.id, 'dispense_log.write', { facilityId: rows[0].id })
  assert.equal(res.decision, false)
  assert.equal(res.reason, 'role lacks permission')
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. Feature configuration still narrows, independently of scope_mode
// ═════════════════════════════════════════════════════════════════════════════

test('a disabled feature still suppresses a permission that inherits its scope', async () => {
  const { rows } = await query(`
    select ur.scope_id facility_id, u.id
      from user_roles ur join users u on u.id = ur.user_id join roles r on r.id = ur.role_id
      left join facilities f on f.id::text = ur.scope_id
     where r.name = 'facility' and u.raw_user_meta_data->>'commodity_section' = 'pharmacy'
       and u.email not like '%.invalid' and u.email not like 'probe.create.%'
       and (f.name is null or f.name !~* 'state office store|cluster lab store')
     limit 1`)
  const { id, facility_id } = rows[0]
  touchedFacilities.push(facility_id)
  try {
    assert.equal((await AclResolver.can(id, 'transfer.write',
      { sendingFacilityId: facility_id })).decision, true, 'baseline')

    await query(
      `insert into feature_config (facility_id, department, feature, enabled)
       values ($1, 'pharmacy', 'transfer', false)
       on conflict (facility_id, department, feature) do update set enabled = false`,
      [facility_id])

    const res = await AclResolver.can(id, 'transfer.write', { sendingFacilityId: facility_id })
    assert.equal(res.decision, false, 'feature config must still narrow')
    assert.equal(res.reason, 'feature disabled for this department')
  } finally {
    await query(`delete from feature_config where facility_id = $1`, [facility_id])
  }
})

test('this suite restored the scope_mode data it touched', async () => {
  const { rows } = await query(
    `select scope_mode, count(*)::int n from role_permissions group by 1 order by 1`)
  assert.deepEqual(rows, [
    { scope_mode: 'inherit', n: 129 },
    { scope_mode: 'own_facility_only', n: 9 },
  ])
  // Scoped to the facilities THIS suite writes to. aclFeatureConfig.test.js runs
  // concurrently against the same table and legitimately has rows in flight; a
  // global count would make this assertion about that suite instead of this one.
  const { rows: fc } = await query(
    `select count(*)::int n from feature_config where facility_id = any($1::uuid[])`,
    [touchedFacilities])
  assert.equal(fc[0].n, 0, 'no feature_config row left behind by this suite')
})
