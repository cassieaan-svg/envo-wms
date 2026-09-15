import test from 'node:test'
import assert from 'node:assert/strict'
import { query } from '../src/db.js'
import { LogService } from '../src/services/logService.js'
import { IdempotencyService } from '../src/services/idempotencyService.js'

// Idempotency for the write that will become offline-queueable first (see
// docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms sibling project). A
// device queues a dispense locally, submits it, and — if the response never came back
// (a dropped connection, an app restart before sync finished) — retries the SAME queued
// entry with the SAME client_txn_id. These tests prove that retry is answered with the
// original result rather than dispensing twice.

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
    'delete from dispense_log where facility_id=$1 and commodity_id=$2',
    'delete from stock where facility_id=$1 and commodity_id=$2',
  ]) await query(sql, [fid, cid]).catch(() => {})
  await query('delete from facilities where id=$1', [fid]).catch(() => {})
  await query('delete from commodities where id=$1', [cid]).catch(() => {})
}

const soh = async (fid, cid) => Number((await query(
  'select coalesce(sum(quantity),0) q from stock where facility_id=$1 and commodity_id=$2 and location_type=\'store\'',
  [fid, cid])).rows[0].q)

test('a dispense with a clientTxnId moves stock once and writes one log row', async () => {
  const f = await fixture({ qty: 100 })
  const id = txnId('A')
  try {
    const result = await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 30, dispensed_by: 'tester',
      client_txn_id: id,
    })
    assert.ok(result.id)
    assert.equal(await soh(f.fid, f.cid), 70)

    const { rows } = await query('select count(*)::int n from dispense_log where facility_id=$1', [f.fid])
    assert.equal(rows[0].n, 1)
  } finally {
    await cleanup(f)
  }
})

test('retrying the same clientTxnId does not dispense a second time', async () => {
  const f = await fixture({ qty: 100 })
  const id = txnId('B')
  try {
    const first = await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 30, dispensed_by: 'tester',
      client_txn_id: id,
    })
    // The device never saw the first response and retries the same queued entry.
    const second = await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 30, dispensed_by: 'tester',
      client_txn_id: id,
    })

    assert.equal(second.id, first.id, 'the retry is answered with the original row, not a new one')
    assert.equal(await soh(f.fid, f.cid), 70, 'stock left the shelf once, not twice')

    const { rows } = await query('select count(*)::int n from dispense_log where facility_id=$1', [f.fid])
    assert.equal(rows[0].n, 1, 'only one log row exists')
  } finally {
    await cleanup(f)
  }
})

test('two concurrent submits with the same clientTxnId still only dispense once', async () => {
  const f = await fixture({ qty: 100 })
  const id = txnId('C')
  try {
    const [a, b] = await Promise.all([
      LogService.recordDispense({ facility_id: f.fid, commodity_id: f.cid, quantity: 25, dispensed_by: 'tester', client_txn_id: id }),
      LogService.recordDispense({ facility_id: f.fid, commodity_id: f.cid, quantity: 25, dispensed_by: 'tester', client_txn_id: id }),
    ])
    assert.equal(a.id, b.id, 'both calls resolve to the same log row')
    assert.equal(await soh(f.fid, f.cid), 75, 'stock left the shelf exactly once')
  } finally {
    await cleanup(f)
  }
})

test('a different clientTxnId is a genuinely new dispense', async () => {
  const f = await fixture({ qty: 100 })
  try {
    const first = await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 10, dispensed_by: 'tester', client_txn_id: txnId('D1'),
    })
    const second = await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 10, dispensed_by: 'tester', client_txn_id: txnId('D2'),
    })
    assert.notEqual(first.id, second.id)
    assert.equal(await soh(f.fid, f.cid), 80, 'two genuine dispenses, both applied')
  } finally {
    await cleanup(f)
  }
})

test('a dispense with no clientTxnId still works, unchanged, for the existing online client', async () => {
  const f = await fixture({ qty: 50 })
  try {
    const result = await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 5, dispensed_by: 'tester',
    })
    assert.ok(result.id)
    assert.equal(await soh(f.fid, f.cid), 45)
    // No idempotency row was ever created for this one — it never claimed an id.
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
      { clientTxnId: id, operation: 'intake', facilityId: f.fid }
    )
    await assert.rejects(
      LogService.recordDispense({ facility_id: f.fid, commodity_id: f.cid, quantity: 5, dispensed_by: 'tester', client_txn_id: id }),
      (err) => { assert.equal(err.status, 409); assert.match(err.message, /different operation/); return true }
    )
  } finally {
    await cleanup(f)
  }
})

test('a malformed clientTxnId is refused by the validator (the route calls this before recordDispense)', () => {
  // Format-checking lives at the route layer (see routes/dispense.js), same split as
  // envo-wms's own IdempotencyService — the service's claim() trusts whatever id it's
  // given and only cares about uniqueness/ownership, not shape.
  assert.throws(
    () => IdempotencyService.validate('nope'),
    (err) => { assert.equal(err.status, 400); return true }
  )
  assert.equal(IdempotencyService.validate(null), null, 'absent stays absent, not an error')
})
