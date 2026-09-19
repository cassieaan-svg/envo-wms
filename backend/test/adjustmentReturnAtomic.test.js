import test from 'node:test'
import assert from 'node:assert/strict'
import { query } from '../src/db.js'
import { LogService } from '../src/services/logService.js'
import { LotService } from '../src/services/lotService.js'

// The "Returned from Dispensary" flow: one atomic transaction that credits the store
// and debits the dispensary, both read and written server-side against the current
// authoritative quantity. Replaces a client-orchestrated two-call version (POST
// adjustment, then a separate PATCH setting the dispensary to an absolute
// client-computed figure) that couldn't be made offline-safe — see the comment on
// LogService.recordAdjustment and docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the
// envo-wms sibling project.

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 10000)}`
const txnId = (label) => `${label}-${uniq()}`.replace(/[^A-Za-z0-9_-]/g, '-')

async function fixture({ storeQty = 50, dispensaryQty = 30 } = {}) {
  const fid = (await query('insert into facilities (name) values ($1) returning id',
    [`T-Ret-Fac-${uniq()}`])).rows[0].id
  const cid = (await query('insert into commodities (name, category, unit) values ($1,$2,$3) returning id',
    [`T-Ret-Comm-${uniq()}`, 'Lab consumables', 'unit'])).rows[0].id
  await query(
    `insert into stock (facility_id, commodity_id, quantity, location_type, updated_at)
     values ($1,$2,$3,'store', now())`, [fid, cid, storeQty])
  await query(
    `insert into stock (facility_id, commodity_id, quantity, location_type, updated_at)
     values ($1,$2,$3,'dispensary', now())`, [fid, cid, dispensaryQty])
  await LotService.credit(query, { facility_id: fid, commodity_id: cid, location_type: 'dispensary', site_name: null },
    { batch: 'B1', expiry: '2030-01-01', qty: dispensaryQty })
  return { fid, cid }
}

async function cleanup({ fid, cid }) {
  for (const sql of [
    'delete from idempotent_operations where facility_id=$1',
    'delete from stock_lot where facility_id=$1 and commodity_id=$2',
    'delete from stock_adjustment_log where facility_id=$1 and commodity_id=$2',
    'delete from stock where facility_id=$1 and commodity_id=$2',
  ]) await query(sql, [fid, cid]).catch(() => {})
  await query('delete from facilities where id=$1', [fid]).catch(() => {})
  await query('delete from commodities where id=$1', [cid]).catch(() => {})
}

const sohAt = async (fid, cid, loc) => Number((await query(
  'select coalesce(quantity,0) q from stock where facility_id=$1 and commodity_id=$2 and location_type=$3',
  [fid, cid, loc])).rows[0]?.q ?? 0)

function returnArgs(f, id, overrides = {}) {
  return {
    facility_id: f.fid, commodity_id: f.cid, quantity: 10, adjustment_type: 'Increase',
    reason: 'Returned from Dispensary', adjusted_by: 'tester', location_type: 'store',
    return_from_location_type: 'dispensary', client_txn_id: id,
    ...overrides,
  }
}

test('a return credits the store and debits the dispensary in one call', async () => {
  const f = await fixture({ storeQty: 50, dispensaryQty: 30 })
  const id = txnId('A')
  try {
    const result = await LogService.recordAdjustment(returnArgs(f, id))
    assert.ok(result.id)
    assert.equal(await sohAt(f.fid, f.cid, 'store'), 60)
    assert.equal(await sohAt(f.fid, f.cid, 'dispensary'), 20)
  } finally {
    await cleanup(f)
  }
})

test('retrying the same clientTxnId does not apply the return twice', async () => {
  const f = await fixture({ storeQty: 50, dispensaryQty: 30 })
  const id = txnId('B')
  const args = returnArgs(f, id)
  try {
    const first = await LogService.recordAdjustment(args)
    const second = await LogService.recordAdjustment(args)
    assert.equal(second.id, first.id)
    assert.equal(await sohAt(f.fid, f.cid, 'store'), 60, 'store credited once, not twice')
    assert.equal(await sohAt(f.fid, f.cid, 'dispensary'), 20, 'dispensary debited once, not twice')
  } finally {
    await cleanup(f)
  }
})

test('a return that would overdraw the dispensary clamps it to zero (ENFORCE_BIN_STOCK off in dev, same as every other adjustment)', async () => {
  const f = await fixture({ storeQty: 50, dispensaryQty: 5 })
  const id = txnId('C')
  try {
    const result = await LogService.recordAdjustment(returnArgs(f, id, { quantity: 10 }))
    assert.ok(result.id)
    assert.equal(await sohAt(f.fid, f.cid, 'store'), 60, 'store still credited the full amount')
    assert.equal(await sohAt(f.fid, f.cid, 'dispensary'), 0, 'dispensary clamped to zero, not negative')
  } finally {
    await cleanup(f)
  }
})

test('return_from bin must differ from the credited bin', async () => {
  const f = await fixture()
  try {
    await assert.rejects(
      LogService.recordAdjustment(returnArgs(f, txnId('D'), { return_from_location_type: 'store' })),
      /must be different/
    )
  } finally {
    await cleanup(f)
  }
})

test('a return must be an Increase', async () => {
  const f = await fixture()
  try {
    await assert.rejects(
      LogService.recordAdjustment(returnArgs(f, txnId('E'), { adjustment_type: 'Decrease' })),
      /must be "Increase"/
    )
  } finally {
    await cleanup(f)
  }
})
