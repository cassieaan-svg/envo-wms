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

const OWN_FACILITY_ONLY = ['dispense_log.write', 'intake_log.write', 'adjustment_log.write']
const CROSS_FACILITY_OK = ['stock.write', 'dsd_stock.write', 'sdp_stock.write', 'amc_settings.write']

async function realUser(roleName) {
  const scopeCond = roleName === 'overall_admin' ? '' : `and ur.scope_id <> ''`
  const { rows } = await query(
    `select u.id, ur.scope_type, ur.scope_id
       from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id
      where r.name = $1 and u.email not like '%.invalid' ${scopeCond} limit 1`, [roleName])
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
    { name: 'facility', n: 3 },
    { name: 'state_admin', n: 3 },
  ])
})

test('scope_mode defaults to inherit, preserving existing behaviour', async () => {
  const { rows } = await query(
    `select count(*)::int n from role_permissions where scope_mode = 'inherit'`)
  assert.equal(rows[0].n, 101, 'every other grant is untouched')
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
  // The CHECK constraint makes this unreachable through normal writes, so it is
  // forced here to prove the resolver does not fall through to "allow" on a
  // value it does not understand.
  const u = await realUser('facility')
  const { rows: role } = await query(`select id from roles where name = 'facility'`)
  await query(`alter table role_permissions drop constraint role_permissions_scope_mode_check`)
  try {
    await query(
      `update role_permissions set scope_mode = 'something_unrecognised'
        where role_id = $1 and permission_key = 'stock.write'`, [role[0].id])

    const res = await AclResolver.can(u.id, 'stock.write', { facilityId: u.scope_id })
    assert.equal(res.decision, false, 'an unrecognised scope_mode must never allow')
    assert.match(res.reason, /unrecognised scope_mode/)
  } finally {
    await query(
      `update role_permissions set scope_mode = 'inherit'
        where role_id = $1 and permission_key = 'stock.write'`, [role[0].id])
    await query(`alter table role_permissions
      add constraint role_permissions_scope_mode_check
      check (scope_mode in ('inherit','own_facility_only'))`)
  }
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
       and u.email not like '%.invalid'
       and (f.name is null or f.name !~* 'state office store|cluster lab store')
     limit 1`)
  const { id, facility_id } = rows[0]
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
    { scope_mode: 'inherit', n: 101 },
    { scope_mode: 'own_facility_only', n: 6 },
  ])
  const { rows: fc } = await query(`select count(*)::int n from feature_config`)
  assert.equal(fc[0].n, 0, 'no feature_config row left behind')
})
