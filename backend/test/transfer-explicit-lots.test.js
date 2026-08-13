import test from 'node:test'
import assert from 'node:assert/strict'
import { withTransaction, query } from '../src/db.js'
import { TransferService } from '../src/services/transferService.js'
import { StockService } from '../src/services/stockService.js'
import { LotService } from '../src/services/lotService.js'

// Integration test: dispatch with explicit lots (50 + 150 → 200)
// Creates ephemeral facility/commodity/stock rows, seeds lots, creates a transfer,
// then calls TransferService.dispatch with explicit `lots` and verifies the
// sender's aggregate stock and lot ledger decremented accordingly and the
// transfer row recorded the drawn lots.

test('dispatch with explicit lots deducts per-batch quantities atomically', async () => {
  // Use committed inserts (via `query`) so TransferService.dispatch can read the
  // transfer row in its own transaction. Clean up afterwards.
  let fid, cid, stockId, recvId, transferId
  try {
    const fRes = await query("insert into facilities (name) values ('T-Dispatch-Store') returning id")
    fid = fRes.rows[0].id
    const cRes = await query("insert into commodities (name, category, unit) values ('T-Commodity', 'pharmacy', 'unit') returning id")
    cid = cRes.rows[0].id

    const sRes = await query(`insert into stock (facility_id, commodity_id, quantity, location_type, updated_at) values ($1,$2,$3,'store', now()) returning id`, [fid, cid, 200])
    stockId = sRes.rows[0].id
    await withTransaction(async exec => {
      await LotService.credit(exec, { facility_id: fid, commodity_id: cid, location_type: 'store' }, { batch: 'A', expiry: null, qty: 50 })
      await LotService.credit(exec, { facility_id: fid, commodity_id: cid, location_type: 'store' }, { batch: 'B', expiry: null, qty: 150 })
    })

    const recvRes = await query("insert into facilities (name) values ('T-Recv') returning id")
    recvId = recvRes.rows[0].id
    const trRes = await query(`insert into stock_transfer_log (sending_facility_id, sending_facility_name, receiving_facility_id, receiving_facility_name, commodity_id, commodity_name, quantity, qty_requested, status, notes, initiated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $7, 'pending', 'test', now()) returning id, status, lots, quantity`, [fid, 'Store', recvId, 'Recv', cid, 'T-Commodity', 200])
    transferId = trRes.rows[0].id

    const lotsPayload = [{ batch: 'A', quantity: 50 }, { batch: 'B', quantity: 150 }]
    const dispatched = await TransferService.dispatch(transferId, { approved_by: 'tester', carrier: 'van', expiry: '', quantity: 200, lots: lotsPayload })
    assert.ok(dispatched, 'dispatch returned a row')
    assert.equal(dispatched.status, 'in_transit')
    assert.equal(dispatched.quantity, 200)
    assert.ok(Array.isArray(dispatched.lots) && dispatched.lots.length > 0, 'transfer.lots recorded')

    const { rows: s2 } = await query('select quantity from stock where id = $1', [stockId])
    assert.equal(s2[0].quantity, 0)

    const { rows: lotsLeft } = await query('select coalesce(sum(quantity),0) t from stock_lot where facility_id=$1 and commodity_id=$2 and location_type=$3', [fid, cid, 'store'])
    assert.equal(Number(lotsLeft[0].t), 0)
  } finally {
    // Best-effort cleanup
    if (transferId) await query('delete from stock_transfer_log where id = $1', [transferId]).catch(() => {})
    if (stockId) await query('delete from stock where id = $1', [stockId]).catch(() => {})
    if (fid && cid) await query('delete from stock_lot where facility_id=$1 and commodity_id=$2', [fid, cid]).catch(() => {})
    if (recvId) await query('delete from facilities where id = $1', [recvId]).catch(() => {})
    if (fid) await query('delete from facilities where id = $1', [fid]).catch(() => {})
    if (cid) await query('delete from commodities where id = $1', [cid]).catch(() => {})
  }
})
