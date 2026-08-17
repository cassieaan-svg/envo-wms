import test from 'node:test'
import assert from 'node:assert/strict'
import { query, withTransaction } from '../src/db.js'
import { LogService } from '../src/services/logService.js'
import { LotService } from '../src/services/lotService.js'

// Editing a movement's quantity to ZERO is how a mistaken entry is undone: the row
// stays (so the edit history still shows what was entered and who cancelled it) but
// the stock it moved goes back. These tests lock that behaviour to the stock, not
// just to the log row — the whole point is that the two move together.

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 10000)}`

async function fixture({ location_type, qty }) {
  const fid = (await query('insert into facilities (name) values ($1) returning id',
    [`T-Zero-Fac-${uniq()}`])).rows[0].id
  const cid = (await query('insert into commodities (name, category, unit) values ($1,$2,$3) returning id',
    [`T-Zero-Comm-${uniq()}`, 'Lab consumables', 'unit'])).rows[0].id
  const sid = (await query(
    `insert into stock (facility_id, commodity_id, quantity, location_type, updated_at)
     values ($1,$2,$3,$4, now()) returning id`, [fid, cid, qty, location_type])).rows[0].id
  return { fid, cid, sid }
}

async function cleanup({ fid, cid }) {
  // Children first: stock_lot and the log rows reference the commodity/facility, so
  // deleting the parents first fails on the foreign key and leaks the fixture.
  for (const sql of [
    'delete from stock_lot where facility_id=$1 and commodity_id=$2',
    'delete from dispense_log where facility_id=$1 and commodity_id=$2',
    'delete from intake_log where facility_id=$1 and commodity_id=$2',
    'delete from stock_adjustment_log where facility_id=$1 and commodity_id=$2',
    'delete from stock where facility_id=$1 and commodity_id=$2',
  ]) await query(sql, [fid, cid]).catch(() => {})
  await query('delete from facilities where id=$1', [fid]).catch(() => {})
  await query('delete from commodities where id=$1', [cid]).catch(() => {})
}

const soh = async (fid, cid, loc) => Number((await query(
  'select coalesce(sum(quantity),0) q from stock where facility_id=$1 and commodity_id=$2 and location_type=$3',
  [fid, cid, loc])).rows[0].q)

test('editing a dispense to zero returns the stock it took', async () => {
  // 100 on hand, 30 dispensed -> 70 left in the dispensary (a dispense with no
  // DSD/SDP tag draws from the dispensary, which is the bin that must be restored).
  const f = await fixture({ location_type: 'dispensary', qty: 70 })
  try {
    const logId = (await query(
      `insert into dispense_log (facility_id, commodity_id, quantity, dispensed_by, dispensed_at)
       values ($1,$2,30,'tester', now()) returning id`, [f.fid, f.cid])).rows[0].id

    const updated = await LogService.updateLog('dispense', logId, { quantity: 0 })

    assert.equal(updated.quantity, 0, 'the log row records zero')
    assert.equal(await soh(f.fid, f.cid, 'dispensary'), 100,
      'the 30 must come back, restoring the bin to what it held before the dispense')

    // The row is corrected, not erased — the audit trail depends on it surviving.
    const { rows } = await query('select quantity from dispense_log where id=$1', [logId])
    assert.equal(rows.length, 1, 'the record is kept, not deleted')
  } finally {
    await cleanup(f)
  }
})

test('cancelling a consumption returns the stock to its own batch', async () => {
  // The bin total coming back is not enough: it has to come back AS the batch it
  // left as. Reconciling on the total alone credited a lot with no batch and no
  // expiry, so cancelling a consumption of dated stock produced undated stock —
  // which the dispatch path refuses to move, turning one correction into a new
  // problem. The batch and expiry are on the record being edited.
  const f = await fixture({ location_type: 'dispensary', qty: 8 })
  let logId
  try {
    await withTransaction(exec => LotService.credit(exec,
      { facility_id: f.fid, commodity_id: f.cid, location_type: 'dispensary' },
      { batch: 'UF5025421A', expiry: '2028-08-27', qty: 8 }))

    logId = (await query(
      `insert into dispense_log (facility_id, commodity_id, quantity, dispensed_by, dispensed_at, batch_number, expiry_date)
       values ($1,$2,1,'tester', now(), 'UF5025421A', '2028-08-27') returning id`,
      [f.fid, f.cid])).rows[0].id

    await LogService.updateLog('dispense', logId, { quantity: 0 })

    const { rows: lots } = await query(
      `select batch_number, expiry_date::date d, quantity from stock_lot
        where facility_id=$1 and commodity_id=$2 and location_type='dispensary' and quantity > 0
        order by batch_number nulls last`, [f.fid, f.cid])

    assert.equal(lots.length, 1, `the bottle must rejoin its batch, not sit in a second lot: ${JSON.stringify(lots)}`)
    assert.equal(lots[0].batch_number, 'UF5025421A', 'returned to the batch it was taken from')
    assert.equal(Number(lots[0].quantity), 9, 'and the batch holds the returned unit')
    assert.ok(lots[0].d, 'the returned stock keeps its expiry date')
    assert.equal(await soh(f.fid, f.cid, 'dispensary'), 9, 'bin and ledger agree')
  } finally {
    if (logId) await query('delete from dispense_log where id=$1', [logId]).catch(() => {})
    await cleanup(f)
  }
})

test('a partial edit still moves only the difference', async () => {
  // Guards the sign: zero must not be a special case that over- or under-credits.
  const f = await fixture({ location_type: 'dispensary', qty: 70 })
  try {
    const logId = (await query(
      `insert into dispense_log (facility_id, commodity_id, quantity, dispensed_by, dispensed_at)
       values ($1,$2,30,'tester', now()) returning id`, [f.fid, f.cid])).rows[0].id

    await LogService.updateLog('dispense', logId, { quantity: 10 })
    assert.equal(await soh(f.fid, f.cid, 'dispensary'), 90, '30 -> 10 returns 20, not all 30')

    // And zeroing from there returns only the remaining 10.
    await LogService.updateLog('dispense', logId, { quantity: 0 })
    assert.equal(await soh(f.fid, f.cid, 'dispensary'), 100, 'successive edits stay consistent')
  } finally {
    await cleanup(f)
  }
})

test('zeroing an intake removes the stock it added', async () => {
  // The mirror image of the dispense case: cancelling a receipt takes the stock back
  // out. Requires 20260817_intake_adjustment_allow_zero_quantity.sql.
  const f = await fixture({ location_type: 'store', qty: 50 })
  let logId
  try {
    logId = (await query(
      `insert into intake_log (facility_id, commodity_id, quantity, received_by, received_at)
       values ($1,$2,50,'tester', now()) returning id`, [f.fid, f.cid])).rows[0].id

    const updated = await LogService.updateLog('intake', logId, { quantity: 0 })
    assert.equal(updated.quantity, 0, 'the log row records zero')
    assert.equal(await soh(f.fid, f.cid, 'store'), 0, 'the 50 it added is taken back out')
  } finally {
    if (logId) await query('delete from intake_log where id=$1', [logId]).catch(() => {})
    await cleanup(f)
  }
})

test('zeroing a Decrease adjustment returns the stock it took', async () => {
  // Sign check on the other adjustment direction: a Decrease removed stock, so
  // cancelling it must give the stock back, not take more away.
  const f = await fixture({ location_type: 'store', qty: 80 })
  let logId
  try {
    logId = (await query(
      `insert into stock_adjustment_log
         (facility_id, commodity_id, quantity, adjustment_type, reason, adjusted_by, location_type, adjusted_at)
       values ($1,$2,20,'Decrease','Damaged','tester','store', now()) returning id`,
      [f.fid, f.cid])).rows[0].id

    await LogService.updateLog('adjustment', logId, { quantity: 0 })
    assert.equal(await soh(f.fid, f.cid, 'store'), 100, 'the 20 written off comes back')
  } finally {
    if (logId) await query('delete from stock_adjustment_log where id=$1', [logId]).catch(() => {})
    await cleanup(f)
  }
})

test('cancelling an intake whose stock is gone is refused, not clamped', async () => {
  // The hazard unique to cancelling a CREDIT: the bin may no longer hold what the
  // receipt added. Clamping would set it to zero and report success, writing off the
  // 5 that were there. An edit corrects the record; it must never quietly destroy
  // stock to make the arithmetic work. Refused regardless of ENFORCE_BIN_STOCK,
  // which governs live movements rather than corrections.
  const f = await fixture({ location_type: 'store', qty: 5 })
  let logId
  try {
    logId = (await query(
      `insert into intake_log (facility_id, commodity_id, quantity, received_by, received_at)
       values ($1,$2,50,'tester', now()) returning id`, [f.fid, f.cid])).rows[0].id

    const err = await LogService.updateLog('intake', logId, { quantity: 0 }).then(() => null, e => e)
    assert.ok(err, 'must refuse rather than overdraw')
    assert.equal(err.status, 409, 'refused with a conflict, not a 500')
    assert.match(err.message, /holds 5.*would take it to -45/, 'the message names the shortfall')

    // Rolled back: neither the stock nor the record moved.
    assert.equal(await soh(f.fid, f.cid, 'store'), 5, 'the stock is untouched')
    const { rows } = await query('select quantity from intake_log where id=$1', [logId])
    assert.equal(Number(rows[0].quantity), 50, 'the record is untouched')
  } finally {
    if (logId) await query('delete from intake_log where id=$1', [logId]).catch(() => {})
    await cleanup(f)
  }
})
