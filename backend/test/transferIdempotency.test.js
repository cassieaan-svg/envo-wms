import test from 'node:test'
import assert from 'node:assert/strict'
import { query } from '../src/db.js'
import { TransferService } from '../src/services/transferService.js'
import { LotService } from '../src/services/lotService.js'
import { IdempotencyService } from '../src/services/idempotencyService.js'

// Idempotency for transfers — the last (and hardest) write in the offline rollout
// order (see docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms sibling
// project). Unlike dispense/intake/adjustments, a transfer is TWO independent ledger
// events on two different facilities: dispatch debits the sender, accept separately
// credits the receiver. Each must be retry-safe on its own — a device queuing a
// dispatch has no idea whether the receiver has even seen the transfer yet.

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 10000)}`
const txnId = (label) => `${label}-${uniq()}`.replace(/[^A-Za-z0-9_-]/g, '-')

async function fixture({ qty = 100 } = {}) {
  const sendFid = (await query('insert into facilities (name) values ($1) returning id',
    [`T-Idem-Send-${uniq()}`])).rows[0].id
  const recvFid = (await query('insert into facilities (name) values ($1) returning id',
    [`T-Idem-Recv-${uniq()}`])).rows[0].id
  const cid = (await query('insert into commodities (name, category, unit) values ($1,$2,$3) returning id',
    [`T-Idem-Comm-${uniq()}`, 'Lab consumables', 'unit'])).rows[0].id
  await query(
    `insert into stock (facility_id, commodity_id, quantity, location_type, updated_at)
     values ($1,$2,$3,'store', now())`, [sendFid, cid, qty])
  await LotService.credit(query, { facility_id: sendFid, commodity_id: cid, location_type: 'store', site_name: null },
    { batch: `B-${uniq()}`, expiry: '2030-01-01', qty })
  return { sendFid, recvFid, cid }
}

async function makePendingTransfer(f, quantity = 20) {
  const [row] = await TransferService.createTransfers([{
    sending_facility_id: f.sendFid, receiving_facility_id: f.recvFid,
    commodity_id: f.cid, quantity, status: 'pending', initiated_by: 'tester',
  }])
  return row.id
}

async function cleanup(f) {
  const { sendFid, recvFid, cid } = f
  for (const sql of [
    'delete from idempotent_operations where facility_id in ($1,$2)',
    'delete from stock_transfer_log where commodity_id=$3 and (sending_facility_id=$1 or receiving_facility_id=$2)',
    'delete from stock_lot where facility_id in ($1,$2) and commodity_id=$3',
    'delete from stock where facility_id in ($1,$2) and commodity_id=$3',
  ]) await query(sql, [sendFid, recvFid, cid]).catch(() => {})
  await query('delete from facilities where id in ($1,$2)', [sendFid, recvFid]).catch(() => {})
  await query('delete from commodities where id=$1', [cid]).catch(() => {})
}

const soh = async (fid, cid) => Number((await query(
  'select coalesce(sum(quantity),0) q from stock where facility_id=$1 and commodity_id=$2 and location_type=\'store\'',
  [fid, cid])).rows[0].q)

test('dispatch with a clientTxnId debits the sender once', async () => {
  const f = await fixture({ qty: 100 })
  const tid = await makePendingTransfer(f, 20)
  const id = txnId('A')
  try {
    const result = await TransferService.dispatch(tid, { approved_by: 'tester', client_txn_id: id })
    assert.equal(result.status, 'in_transit')
    assert.equal(await soh(f.sendFid, f.cid), 80)
  } finally {
    await cleanup(f)
  }
})

test('retrying dispatch with the same clientTxnId does not debit the sender twice', async () => {
  const f = await fixture({ qty: 100 })
  const tid = await makePendingTransfer(f, 20)
  const id = txnId('B')
  const args = { approved_by: 'tester', client_txn_id: id }
  try {
    const first = await TransferService.dispatch(tid, args)
    const second = await TransferService.dispatch(tid, args)
    assert.equal(second.id, first.id)
    assert.equal(await soh(f.sendFid, f.cid), 80, 'stock left the sender once, not twice')
  } finally {
    await cleanup(f)
  }
})

test('a dispatch retried with NO clientTxnId at all is still refused, not double-applied', async () => {
  // This is the gap that existed before this change: a bare retry (no client_txn_id,
  // e.g. a second click before the offline contract existed) must not silently
  // re-debit the sender just because the row is no longer 'pending'.
  const f = await fixture({ qty: 100 })
  const tid = await makePendingTransfer(f, 20)
  try {
    await TransferService.dispatch(tid, { approved_by: 'tester' })
    assert.equal(await soh(f.sendFid, f.cid), 80)
    await assert.rejects(
      TransferService.dispatch(tid, { approved_by: 'tester' }),
      (err) => { assert.equal(err.status, 409); return true }
    )
    assert.equal(await soh(f.sendFid, f.cid), 80, 'the rejected retry moved nothing')
  } finally {
    await cleanup(f)
  }
})

test('accept with a clientTxnId credits the receiver once', async () => {
  const f = await fixture({ qty: 100 })
  const tid = await makePendingTransfer(f, 20)
  const id = txnId('C')
  try {
    await TransferService.dispatch(tid, { approved_by: 'tester' })
    const result = await TransferService.accept(tid, { received_by: 'tester', client_txn_id: id })
    assert.equal(result.status, 'accepted')
    assert.equal(await soh(f.recvFid, f.cid), 20)
  } finally {
    await cleanup(f)
  }
})

test('retrying accept with the same clientTxnId does not credit the receiver twice', async () => {
  const f = await fixture({ qty: 100 })
  const tid = await makePendingTransfer(f, 20)
  const id = txnId('D')
  const args = { received_by: 'tester', client_txn_id: id }
  try {
    await TransferService.dispatch(tid, { approved_by: 'tester' })
    const first = await TransferService.accept(tid, args)
    const second = await TransferService.accept(tid, args)
    assert.equal(second.id, first.id)
    assert.equal(await soh(f.recvFid, f.cid), 20, 'stock reached the receiver once, not twice')
  } finally {
    await cleanup(f)
  }
})

test('accepting twice with no clientTxnId still only credits once (pre-existing status guard)', async () => {
  const f = await fixture({ qty: 100 })
  const tid = await makePendingTransfer(f, 20)
  try {
    await TransferService.dispatch(tid, { approved_by: 'tester' })
    await TransferService.accept(tid, { received_by: 'tester' })
    await TransferService.accept(tid, { received_by: 'tester' })
    assert.equal(await soh(f.recvFid, f.cid), 20)
  } finally {
    await cleanup(f)
  }
})

test('two concurrent dispatch submits with the same clientTxnId still only debit once', async () => {
  const f = await fixture({ qty: 100 })
  const tid = await makePendingTransfer(f, 15)
  const id = txnId('E')
  const args = { approved_by: 'tester', client_txn_id: id }
  try {
    const [a, b] = await Promise.all([
      TransferService.dispatch(tid, args),
      TransferService.dispatch(tid, args),
    ])
    assert.equal(a.id, b.id)
    assert.equal(await soh(f.sendFid, f.cid), 85)
  } finally {
    await cleanup(f)
  }
})

test('reusing a clientTxnId across dispatch and accept is refused as a different operation', async () => {
  const f = await fixture({ qty: 100 })
  const tid = await makePendingTransfer(f, 20)
  const id = txnId('F')
  try {
    await TransferService.dispatch(tid, { approved_by: 'tester', client_txn_id: id })
    await assert.rejects(
      TransferService.accept(tid, { received_by: 'tester', client_txn_id: id }),
      (err) => { assert.equal(err.status, 409); assert.match(err.message, /different operation/); return true }
    )
  } finally {
    await cleanup(f)
  }
})

test('a malformed clientTxnId is refused by the validator (the routes call this before dispatch/accept)', () => {
  assert.throws(
    () => IdempotencyService.validate('nope'),
    (err) => { assert.equal(err.status, 400); return true }
  )
})
