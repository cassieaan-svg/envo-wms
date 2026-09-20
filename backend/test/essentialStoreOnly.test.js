import test from 'node:test'
import assert from 'node:assert/strict'
import { query } from '../src/db.js'
import { LogService } from '../src/services/logService.js'
import { TransferService } from '../src/services/transferService.js'

// Essential Commodities has no dispensary bin: consumption always debits store,
// server-side, regardless of what the client sends — and internal redistribution
// (store -> dispensary) is refused outright for an essential commodity. See the
// migration comment in db/migrations/20260920b_dispense_log_location_type.sql and
// LogService.recordDispense / TransferService.approveInternal.

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 10000)}`

async function fixture({ module = 'essential', stockQty = 100 } = {}) {
  const fid = (await query('insert into facilities (name) values ($1) returning id',
    [`T-EssStore-Fac-${uniq()}`])).rows[0].id
  const cid = (await query(
    'insert into commodities (name, category, unit, module) values ($1,$2,$3,$4) returning id',
    [`T-EssStore-Comm-${uniq()}`, 'Consumables', 'pack', module])).rows[0].id
  await query(
    `insert into stock (facility_id, commodity_id, quantity, location_type, updated_at)
     values ($1,$2,$3,'store', now())`, [fid, cid, stockQty])
  return { fid, cid }
}

async function cleanup({ fid, cid }) {
  for (const sql of [
    'delete from stock_lot where facility_id=$1 and commodity_id=$2',
    'delete from dispense_log where facility_id=$1 and commodity_id=$2',
    'delete from stock where facility_id=$1 and commodity_id=$2',
    'delete from stock_transfer_log where commodity_id=$2 and sending_facility_id=$1',
  ]) await query(sql, [fid, cid]).catch(() => {})
  await query('delete from facilities where id=$1', [fid]).catch(() => {})
  await query('delete from commodities where id=$1', [cid]).catch(() => {})
}

test('an essential commodity dispense debits store even when the client asks for dispensary', async () => {
  const f = await fixture()
  try {
    const result = await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 10, dispensed_by: 'tester',
      location_type: 'dispensary',   // client sends the old value — server must ignore it
    })
    assert.equal(result.location_type, 'store')

    const { rows } = await query(
      `select quantity from stock where facility_id=$1 and commodity_id=$2 and location_type='store'`,
      [f.fid, f.cid])
    assert.equal(rows[0].quantity, 90, 'the store was debited, not a phantom dispensary bin')

    const disp = await query(
      `select 1 from stock where facility_id=$1 and commodity_id=$2 and location_type='dispensary'`,
      [f.fid, f.cid])
    assert.equal(disp.rows.length, 0, 'no dispensary stock row was created')
  } finally {
    await cleanup(f)
  }
})

test('an HIV commodity dispense still debits dispensary as before (unchanged)', async () => {
  const f = await fixture({ module: 'hiv' })
  // HIV stock lives in dispensary, not store, for this path.
  await query(`update stock set location_type='dispensary' where facility_id=$1 and commodity_id=$2`, [f.fid, f.cid])
  try {
    const result = await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 10, dispensed_by: 'tester',
      location_type: 'dispensary',
    })
    assert.equal(result.location_type, 'dispensary')
  } finally {
    await cleanup(f)
  }
})

test('internal redistribution (store -> dispensary) is refused for an essential commodity', async () => {
  const f = await fixture()
  try {
    const { rows } = await query(
      `insert into stock_transfer_log
         (commodity_id, commodity_name, sending_facility_id, sending_facility_name, receiving_facility_name, quantity, status, initiated_at)
       values ($1, 'test commodity', $2, 'test store', 'test dispensary', 10, 'pending', now()) returning id`,
      [f.cid, f.fid])
    const transferId = rows[0].id
    await assert.rejects(
      TransferService.approveInternal(transferId, { approved_by: 'tester', quantity: 10 }),
      /no dispensary bin/i
    )
  } finally {
    await cleanup(f)
  }
})
