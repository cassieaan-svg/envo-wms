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
    // Real expiry dates: stock is required to carry one, and dispatch now refuses
    // undated lots (see the test below). B is the earlier of the two.
    await withTransaction(async exec => {
      await LotService.credit(exec, { facility_id: fid, commodity_id: cid, location_type: 'store' }, { batch: 'A', expiry: '2027-12-31', qty: 50 })
      await LotService.credit(exec, { facility_id: fid, commodity_id: cid, location_type: 'store' }, { batch: 'B', expiry: '2027-06-30', qty: 150 })
    })

    const recvRes = await query("insert into facilities (name) values ('T-Recv') returning id")
    recvId = recvRes.rows[0].id
    const trRes = await query(`insert into stock_transfer_log (sending_facility_id, sending_facility_name, receiving_facility_id, receiving_facility_name, commodity_id, commodity_name, quantity, qty_requested, status, notes, initiated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $7, 'pending', 'test', now()) returning id, status, lots, quantity`, [fid, 'Store', recvId, 'Recv', cid, 'T-Commodity', 200])
    transferId = trRes.rows[0].id

    const lotsPayload = [{ batch: 'A', quantity: 50 }, { batch: 'B', quantity: 150 }]
    // The expiry is passed as a raw TIMESTAMP on purpose: that is what the dispatch
    // form sends, since it forwards the lot's expiry_date exactly as the lots API
    // returned it. Passing a clean date here would test a case the UI never produces.
    const dispatched = await TransferService.dispatch(transferId, { approved_by: 'tester', carrier: 'van', expiry: '2027-06-29T23:00:00.000Z', quantity: 200, lots: lotsPayload })
    assert.ok(dispatched, 'dispatch returned a row')
    assert.equal(dispatched.status, 'in_transit')
    assert.equal(dispatched.quantity, 200)
    assert.ok(Array.isArray(dispatched.lots) && dispatched.lots.length > 0, 'transfer.lots recorded')

    // The note is read by people, so the expiry must be a plain date. A value taken
    // from the lot ledger arrives as a timestamp and used to land in the note as
    // "2027-06-29T23:00:00.000Z" — and a day early, since UTC midnight is the
    // previous evening in Lagos. B is the earlier batch, so the consignment expires
    // with it.
    const noteExpiry = /\[Expiry: ([^\]]*)\]/.exec(dispatched.notes || '')?.[1]
    assert.match(noteExpiry || '', /^\d{4}-\d{2}-\d{2}$/, `note expiry must be a plain date, got "${noteExpiry}"`)
    assert.equal(noteExpiry, '2027-06-30', 'the earliest drawn expiry, in Lagos time')

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

// Every commodity is meant to carry a batch number and an expiry date. Two rules
// follow, and both are exercised here against the real dispatch path:
//
//   1. a lot with no expiry must not move — the dispatch is refused and rolls back;
//   2. when the operator supplies the missing values inline, they are written back
//      to the lot ledger, not just recorded in the transfer note.
test('dispatch refuses an undated lot, and accepts it once the gap is filled', async () => {
  let fid, cid, stockId, recvId, transferId
  try {
    const fRes = await query("insert into facilities (name) values ('T-Gap-Store') returning id")
    fid = fRes.rows[0].id
    const cRes = await query("insert into commodities (name, category, unit) values ('T-Gap-Commodity', 'Lab consumables', 'unit') returning id")
    cid = cRes.rows[0].id

    const sRes = await query(`insert into stock (facility_id, commodity_id, quantity, location_type, updated_at) values ($1,$2,$3,'store', now()) returning id`, [fid, cid, 40])
    stockId = sRes.rows[0].id
    // The gap under test: stock on hand with neither a batch number nor an expiry.
    await withTransaction(async exec => {
      await LotService.credit(exec, { facility_id: fid, commodity_id: cid, location_type: 'store' }, { batch: '', expiry: null, qty: 40 })
    })

    const recvRes = await query("insert into facilities (name) values ('T-Gap-Recv') returning id")
    recvId = recvRes.rows[0].id
    const trRes = await query(`insert into stock_transfer_log (sending_facility_id, sending_facility_name, receiving_facility_id, receiving_facility_name, commodity_id, commodity_name, quantity, qty_requested, status, notes, initiated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $7, 'pending', 'test', now()) returning id`, [fid, 'Store', recvId, 'Recv', cid, 'T-Gap-Commodity', 25])
    transferId = trRes.rows[0].id

    // 1. Refusal. No expiry anywhere, so the dispatch must be rejected.
    await assert.rejects(
      () => TransferService.dispatch(transferId, { approved_by: 'tester', carrier: 'van', expiry: '', quantity: 25, lots: [{ batch: '', quantity: 25 }] }),
      err => /no expiry date recorded/i.test(err.message),
      'undated stock must not dispatch')

    // The refusal throws inside the transaction, so nothing may have moved.
    const { rows: sAfter } = await query('select quantity from stock where id = $1', [stockId])
    assert.equal(Number(sAfter[0].quantity), 40, 'refused dispatch left the stock alone')
    const { rows: trAfter } = await query('select status from stock_transfer_log where id = $1', [transferId])
    assert.equal(trAfter[0].status, 'pending', 'refused dispatch left the transfer pending')

    // 2. Gap filled inline. The same call, now carrying the corrections. Only 25 of
    //    the 40 move, so the remainder stays behind and can be inspected: the fix is
    //    meant to land on the LOT, not merely travel with the consignment.
    const dispatched = await TransferService.dispatch(transferId, {
      approved_by: 'tester', carrier: 'van', expiry: '', quantity: 25,
      lots: [{ batch: '', quantity: 25, set_batch: 'FIXED-1', set_expiry: '2028-03-31' }],
    })
    assert.equal(dispatched.status, 'in_transit')

    const { rows: lots } = await query(
      `select quantity, batch_number, to_char(expiry_date,'YYYY-MM-DD') expiry from stock_lot
        where commodity_id = $1 and facility_id = $2 and quantity > 0`, [cid, fid])
    assert.equal(lots.length, 1, 'the sender keeps one lot with the remainder')
    assert.equal(Number(lots[0].quantity), 15, 'only the dispatched quantity left the lot')
    assert.equal(lots[0].batch_number, 'FIXED-1', 'the supplied batch number was written to the lot')
    assert.equal(lots[0].expiry, '2028-03-31', 'the supplied expiry was written to the lot')
  } finally {
    if (transferId) await query('delete from stock_transfer_log where id = $1', [transferId]).catch(() => {})
    if (cid) await query('delete from stock where commodity_id = $1', [cid]).catch(() => {})
    if (cid) await query('delete from stock_lot where commodity_id = $1', [cid]).catch(() => {})
    if (recvId) await query('delete from facilities where id = $1', [recvId]).catch(() => {})
    if (fid) await query('delete from facilities where id = $1', [fid]).catch(() => {})
    if (cid) await query('delete from commodities where id = $1', [cid]).catch(() => {})
  }
})
