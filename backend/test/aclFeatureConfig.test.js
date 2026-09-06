// Phase 2H — feature configuration. The original business requirement:
// "turn transfer authorization off for Pharmacy but not Lab."
//
// This is the test that proves the requirement is finally expressible. It uses
// REAL pharmacy and lab users at the SAME facility, disables the transfer
// feature for pharmacy only, and asserts the two diverge — without touching
// anyone's role, permissions, or scope.
//
// SAFETY: every feature_config row created here is removed in `finally`. No
// user, role, permission or scope row is ever modified. feature_config is empty
// before and after this suite, which the last test asserts.
//
// Still shadow-only: nothing reads feature_config in the request path, and
// scope.js remains authoritative.
//
//   npm test --prefix backend

import test from 'node:test'
import assert from 'node:assert/strict'
import { query, pool } from '../src/db.js'
import { AclResolver } from '../src/services/aclResolver.js'
import { FEATURES, FEATURE_BY_PERMISSION, isDeclaredFeature } from '../src/constants/features.js'

test.after(async () => { await pool.end() })

// A facility that has BOTH a pharmacy and a lab user — the whole point is to
// show one department switching off while the other, at the same place, does not.
async function facilityWithBothDepartments() {
  const { rows } = await query(`
    select ur.scope_id facility_id,
           max(case when u.raw_user_meta_data->>'commodity_section' = 'pharmacy' then u.id::text end) pharm,
           max(case when u.raw_user_meta_data->>'commodity_section' = 'lab'      then u.id::text end) lab
      from user_roles ur
      join users u on u.id = ur.user_id
      join roles r on r.id = ur.role_id
      left join facilities f on f.id::text = ur.scope_id
     where r.name = 'facility'
       and u.email not like '%@acl-schema-test.invalid'
       and (f.name is null or f.name !~* 'state office store|cluster lab store')
     group by 1
    having max(case when u.raw_user_meta_data->>'commodity_section' = 'pharmacy' then 1 end) = 1
       and max(case when u.raw_user_meta_data->>'commodity_section' = 'lab'      then 1 end) = 1
     limit 1`)
  if (!rows.length) throw new Error('no facility with both a pharmacy and a lab user')
  return rows[0]
}

const disable = (facilityId, department, feature) => query(
  `insert into feature_config (facility_id, department, feature, enabled)
   values ($1, $2, $3, false)
   on conflict (facility_id, department, feature) do update set enabled = false`,
  [facilityId, department, feature])

const clear = (facilityId) => query(`delete from feature_config where facility_id = $1`, [facilityId])

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE REQUIREMENT — Pharmacy off, Lab on, same facility
// ═════════════════════════════════════════════════════════════════════════════

test('transfers can be disabled for Pharmacy while Lab at the same facility keeps them', async () => {
  const f = await facilityWithBothDepartments()
  try {
    // Baseline: both departments can transfer.
    assert.equal((await AclResolver.can(f.pharm, 'transfer.write',
      { sendingFacilityId: f.facility_id })).decision, true, 'pharmacy baseline')
    assert.equal((await AclResolver.can(f.lab, 'transfer.write',
      { sendingFacilityId: f.facility_id })).decision, true, 'lab baseline')

    // One row. No role changed, no permission revoked, no scope touched.
    await disable(f.facility_id, 'pharmacy', 'transfer')

    const pharmacy = await AclResolver.can(f.pharm, 'transfer.write', { sendingFacilityId: f.facility_id })
    const lab = await AclResolver.can(f.lab, 'transfer.write', { sendingFacilityId: f.facility_id })

    assert.equal(pharmacy.decision, false, 'pharmacy must lose transfers')
    assert.equal(pharmacy.reason, 'feature disabled for this department')
    assert.equal(lab.decision, true, 'lab at the SAME facility must be unaffected')
  } finally {
    await clear(f.facility_id)
  }
})

test('re-enabling is one row — the user gets it back with no permission change', async () => {
  const f = await facilityWithBothDepartments()
  try {
    await disable(f.facility_id, 'pharmacy', 'transfer')
    assert.equal((await AclResolver.can(f.pharm, 'transfer.write',
      { sendingFacilityId: f.facility_id })).decision, false)

    await query(`update feature_config set enabled = true
                  where facility_id = $1 and department = 'pharmacy' and feature = 'transfer'`,
      [f.facility_id])
    assert.equal((await AclResolver.can(f.pharm, 'transfer.write',
      { sendingFacilityId: f.facility_id })).decision, true, 'flipping the row restores it')
  } finally {
    await clear(f.facility_id)
  }
})

test('disabling at one facility does not affect the same department elsewhere', async () => {
  // The consequence of keying on facility x department with no wildcards.
  const f = await facilityWithBothDepartments()
  const { rows: other } = await query(`
    select u.id, ur.scope_id facility_id from user_roles ur
      join users u on u.id = ur.user_id join roles r on r.id = ur.role_id
     where r.name = 'facility' and u.raw_user_meta_data->>'commodity_section' = 'pharmacy'
       and ur.scope_id <> $1 and u.email not like '%@acl-schema-test.invalid' limit 1`,
    [f.facility_id])
  if (!other.length) return
  try {
    await disable(f.facility_id, 'pharmacy', 'transfer')
    assert.equal((await AclResolver.can(other[0].id, 'transfer.write',
      { sendingFacilityId: other[0].facility_id })).decision, true,
      'a pharmacy user at another facility keeps transfers')
  } finally {
    await clear(f.facility_id)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. Deny-only — configuration can never grant
// ═════════════════════════════════════════════════════════════════════════════

test('configuration can never grant: enabling a feature does not confer a missing permission', async () => {
  // The property that keeps configuration from being a privilege-escalation
  // surface. state_viewer holds no write permission at all; an enabling row
  // must not change that.
  const { rows } = await query(`
    select u.id, ur.scope_id from user_roles ur
      join users u on u.id = ur.user_id join roles r on r.id = ur.role_id
     where r.name = 'state_viewer' limit 1`)
  const { rows: fac } = await query(`select id from facilities limit 1`)
  try {
    await query(
      `insert into feature_config (facility_id, department, feature, enabled)
       values ($1, 'pharmacy', 'transfer', true)
       on conflict (facility_id, department, feature) do update set enabled = true`,
      [fac[0].id])
    const res = await AclResolver.can(rows[0].id, 'transfer.write', { sendingFacilityId: fac[0].id })
    assert.equal(res.decision, false, 'an enabled feature must not grant a permission the role lacks')
    assert.equal(res.reason, 'role lacks permission', 'denied by capability, never reached configuration')
  } finally {
    await clear(fac[0].id)
  }
})

test('a disabled feature cannot rescue a user who already lacks the permission', async () => {
  // Ordering check: capability is evaluated BEFORE configuration, so the reason
  // reported is the capability failure — configuration never decides for a user
  // who was already denied.
  const { rows } = await query(`
    select u.id from user_roles ur join users u on u.id = ur.user_id
      join roles r on r.id = ur.role_id where r.name = 'lga_admin' limit 1`)
  const { rows: fac } = await query(`select id from facilities limit 1`)
  const res = await AclResolver.can(rows[0].id, 'transfer.write', { sendingFacilityId: fac[0].id })
  assert.equal(res.decision, false)
  assert.equal(res.reason, 'role lacks permission')
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. Absent row = enabled; read is never gated
// ═════════════════════════════════════════════════════════════════════════════

test('an absent row means enabled — the table starts empty and nothing breaks', async () => {
  const { rows } = await query(`select count(*)::int n from feature_config`)
  assert.equal(rows[0].n, 0, 'no configuration exists by default')
  const f = await facilityWithBothDepartments()
  assert.equal((await AclResolver.can(f.pharm, 'transfer.write',
    { sendingFacilityId: f.facility_id })).decision, true)
})

test('disabling transfers does NOT hide transfer history', async () => {
  // transfer.read is deliberately not gated: the external-redistribution module
  // is kept "view/print only" precisely so past transfers stay readable. Gating
  // reads would break printing historical forms.
  const f = await facilityWithBothDepartments()
  try {
    await disable(f.facility_id, 'pharmacy', 'transfer')
    assert.equal((await AclResolver.can(f.pharm, 'transfer.read',
      { sendingFacilityId: f.facility_id })).decision, true,
      'history must remain readable when the workflow is switched off')
  } finally {
    await clear(f.facility_id)
  }
})

test('a feature disable only affects the permissions it declares', async () => {
  const f = await facilityWithBothDepartments()
  try {
    await disable(f.facility_id, 'pharmacy', 'transfer')
    // stock.write is not gated by the transfer feature.
    assert.equal((await AclResolver.can(f.pharm, 'stock.write',
      { facilityId: f.facility_id })).decision, true, 'unrelated permissions are untouched')
  } finally {
    await clear(f.facility_id)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. Registry integrity
// ═════════════════════════════════════════════════════════════════════════════

test('every feature in the registry maps to declared permission keys', async () => {
  const { rows } = await query(`select key from permissions`)
  const known = new Set(rows.map(r => r.key))
  for (const [feature, keys] of Object.entries(FEATURES)) {
    assert.ok(keys.length > 0, `${feature} gates nothing`)
    for (const k of keys) assert.ok(known.has(k), `${feature} gates unknown permission ${k}`)
  }
})

test('the transfer feature gates write but not read', async () => {
  assert.equal(FEATURE_BY_PERMISSION['transfer.write'], 'transfer')
  assert.equal(FEATURE_BY_PERMISSION['transfer.read'], undefined,
    'gating reads would hide history — see features.js')
})

test('no feature_config row names an undeclared feature', async () => {
  const { rows } = await query(`select distinct feature from feature_config`)
  for (const r of rows) {
    assert.ok(isDeclaredFeature(r.feature),
      `${r.feature} is in the database but not declared in src/constants/features.js`)
  }
})

test('this suite left feature_config empty', async () => {
  const { rows } = await query(`select count(*)::int n from feature_config`)
  assert.equal(rows[0].n, 0, 'every row created here must be cleaned up')
})
