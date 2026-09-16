import test from 'node:test'
import assert from 'node:assert/strict'
import { query } from '../src/db.js'
import { LogService } from '../src/services/logService.js'
import { IdempotencyService } from '../src/services/idempotencyService.js'

// Idempotency for adjustments, the third write in the offline rollout order (see
// docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms sibling project). A
// device queues an adjustment locally, submits it, and — if the response never came
// back — retries the SAME queued entry with the SAME client_txn_id. These tests prove
// that retry is answered with the original result rather than applying it twice.

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 10000)}`
const txnId = (label) => `${label}-${uniq()}`.replace(/[^A-Za-z0-9_-]/g, '-')

async function fixture({ qty = 100 } = {}) {
  const fid = (await query('insert into facilities (name) values ($1) returning id',
    [`T-Idem-Fac-${uniq()}`])).rows[0].id
  const cid = (await query('insert into commodities (name, category, unit) values ($1,$2,$3) returning id',
    [`T-Idem-Comm-${uniq()}`, 'Lab consumables', 'unit'])).rows[0].id
  await query(
    `insert into stock (facility_id, commodity_id, quantity, location_type, updated_at)
     values ($1,$2,$3,'store', now())`, [fid, cid, qty])
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

const soh = async (fid, cid) => Number((await query(
  'select coalesce(sum(quantity),0) q from stock where facility_id=$1 and commodity_id=$2 and location_type=\'store\'',
  [fid, cid])).rows[0].q)

function adjArgs(f, id, overrides = {}) {
  return {
    facility_id: f.fid, commodity_id: f.cid, quantity: 20, adjustment_type: 'Decrease',
    reason: 'Damaged', adjusted_by: 'tester', client_txn_id: id,
    ...overrides,
  }
}

test('an adjustment with a clientTxnId applies once and writes one log row', async () => {
  const f = await fixture({ qty: 100 })
  const id = txnId('A')
  try {
    const result = await LogService.recordAdjustment(adjArgs(f, id))
    assert.ok(result.id)
    assert.equal(await soh(f.fid, f.cid), 80)

    const { rows } = await query('select count(*)::int n from stock_adjustment_log where facility_id=$1', [f.fid])
    assert.equal(rows[0].n, 1)
  } finally {
    await cleanup(f)
  }
})

test('retrying the same clientTxnId does not apply the adjustment a second time', async () => {
  const f = await fixture({ qty: 100 })
  const id = txnId('B')
  const args = adjArgs(f, id)
  try {
    const first = await LogService.recordAdjustment(args)
    const second = await LogService.recordAdjustment(args)

    assert.equal(second.id, first.id, 'the retry is answered with the original row, not a new one')
    assert.equal(await soh(f.fid, f.cid), 80, 'stock moved once, not twice')

    const { rows } = await query('select count(*)::int n from stock_adjustment_log where facility_id=$1', [f.fid])
    assert.equal(rows[0].n, 1, 'only one log row exists')
  } finally {
    await cleanup(f)
  }
})

test('two concurrent submits with the same clientTxnId still only apply once', async () => {
  const f = await fixture({ qty: 100 })
  const id = txnId('C')
  const args = adjArgs(f, id, { quantity: 15 })
  try {
    const [a, b] = await Promise.all([
      LogService.recordAdjustment(args),
      LogService.recordAdjustment(args),
    ])
    assert.equal(a.id, b.id, 'both calls resolve to the same log row')
    assert.equal(await soh(f.fid, f.cid), 85, 'stock moved exactly once')
  } finally {
    await cleanup(f)
  }
})

test('a different clientTxnId is a genuinely new adjustment', async () => {
  const f = await fixture({ qty: 100 })
  try {
    const first = await LogService.recordAdjustment(adjArgs(f, txnId('D1'), { quantity: 10 }))
    const second = await LogService.recordAdjustment(adjArgs(f, txnId('D2'), { quantity: 10 }))
    assert.notEqual(first.id, second.id)
    assert.equal(await soh(f.fid, f.cid), 80, 'two genuine adjustments, both applied')
  } finally {
    await cleanup(f)
  }
})

test('an adjustment with no clientTxnId still works, unchanged, for the existing online client', async () => {
  const f = await fixture({ qty: 50 })
  try {
    const result = await LogService.recordAdjustment({
      facility_id: f.fid, commodity_id: f.cid, quantity: 5, adjustment_type: 'Decrease',
      reason: 'Damaged', adjusted_by: 'tester',
    })
    assert.ok(result.id)
    assert.equal(await soh(f.fid, f.cid), 45)
    const { rows } = await query('select count(*)::int n from idempotent_operations where facility_id=$1', [f.fid])
    assert.equal(rows[0].n, 0)
  } finally {
    await cleanup(f)
  }
})

test('reusing a clientTxnId for a different operation type is refused', async () => {
  const f = await fixture()
  const id = txnId('E')
  try {
    await IdempotencyService.claim(
      async (text, params) => query(text, params),
      { clientTxnId: id, operation: 'dispense', facilityId: f.fid }
    )
    await assert.rejects(
      LogService.recordAdjustment(adjArgs(f, id)),
      (err) => { assert.equal(err.status, 409); assert.match(err.message, /different operation/); return true }
    )
  } finally {
    await cleanup(f)
  }
})
