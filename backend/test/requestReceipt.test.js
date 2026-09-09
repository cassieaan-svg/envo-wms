// recordReceipt previously had no transaction, no status guard, and never changed
// requests.status at all — received_by/received_at sat as side-facts beside a status that
// stayed 'dispatched' forever. This covers the fix: 'received' is now a real terminal
// status, reachable only from 'dispatched', and a repeated/re-delivered receipt
// confirmation (EnVo's callback can arrive twice) is a no-op rather than an error or a
// silent overwrite.

import test from 'node:test';
import assert from 'node:assert/strict';
import pool, { query } from '../src/db.js';
import { RequestService } from '../src/services/requestService.js';
import { makeUser, makeFacility, makeCommodity, makeBatch, cleanup, txnId } from './helpers.js';

test.after(async () => { await pool.end(); });

async function makeRequest(facility, commodity, quantity = 100) {
  const envoId = `RCPT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await query('INSERT INTO commodity_prices (commodity_id, unit_price, is_current) VALUES ($1, 10, true)',
    [commodity.id]);
  const req = await RequestService.receiveFromEnvo({
    envoRequestId: envoId, envoFacilityId: null, facilityName: facility.name,
    items: [{ wmsCommodityId: commodity.id, quantity }], requestedBy: 'Facility Officer',
  });
  return { req, envoId };
}

async function dropRequest(requestId, envoId, commodityId) {
  await query('UPDATE inventory_transactions SET request_id = NULL WHERE request_id = $1', [requestId]);
  await query('DELETE FROM request_status_events WHERE request_id = $1', [requestId]);
  await query('DELETE FROM request_items WHERE request_id = $1', [requestId]);
  await query('UPDATE requests SET dispatch_order_id = NULL WHERE id = $1', [requestId]);
  await query("DELETE FROM outbox WHERE payload->>'envoRequestId' = $1", [envoId]);
  await query('DELETE FROM requests WHERE id = $1', [requestId]);
  if (commodityId) await query('DELETE FROM commodity_prices WHERE commodity_id = $1', [commodityId]);
}

async function dispatchedRequest(user, facility, commodity, qty = 80) {
  await makeBatch(commodity.id, 500);
  const { req, envoId } = await makeRequest(facility, commodity, qty);
  const id = txnId('RCPT');
  await RequestService.markPicking(req.id, { pickedBy: 'Picker' });
  const dispatched = await RequestService.fulfil(req.id, {
    dispatchedBy: 'Store Officer', carrierName: 'Driver', carrierPhone: '08012345678',
    clientTxnId: id, actorUserId: user.id,
  });
  return { dispatched, envoId };
}

test('recording a receipt moves a dispatched request to received', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { dispatched, envoId } = await dispatchedRequest(user, facility, commodity);

  try {
    const received = await RequestService.recordReceipt(dispatched.id, { receivedBy: 'Nurse Amaka' });
    assert.equal(received.status, 'received');
    assert.equal(received.received_by, 'Nurse Amaka');
    assert.ok(received.received_at);
  } finally {
    await dropRequest(dispatched.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id], clientTxnIds: [] });
  }
});

test('a repeated receipt confirmation is a no-op, not an error', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { dispatched, envoId } = await dispatchedRequest(user, facility, commodity);

  try {
    const first = await RequestService.recordReceipt(dispatched.id, { receivedBy: 'Nurse Amaka' });
    const second = await RequestService.recordReceipt(dispatched.id, { receivedBy: 'Someone Else' });

    assert.equal(second.status, 'received');
    assert.equal(second.received_by, first.received_by, 'the original receipt is not overwritten by a replay');
    assert.equal(second.received_at.getTime?.() ?? second.received_at, first.received_at.getTime?.() ?? first.received_at);
  } finally {
    await dropRequest(dispatched.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('a request that has not shipped yet cannot be receipted', async () => {
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { req, envoId } = await makeRequest(facility, commodity, 10);

  try {
    await assert.rejects(
      RequestService.recordReceipt(req.id, { receivedBy: 'Nurse Amaka' }),
      /has not been dispatched/
    );
    const { rows } = await query('SELECT status FROM requests WHERE id = $1', [req.id]);
    assert.equal(rows[0].status, 'pending', 'status is untouched by the refused attempt');
  } finally {
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id] });
  }
});

test('a rejected request cannot be receipted', async () => {
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { req, envoId } = await makeRequest(facility, commodity, 10);

  try {
    await RequestService.reject(req.id, { rejectedBy: 'Store Officer', reason: 'no stock' });
    await assert.rejects(
      RequestService.recordReceipt(req.id, { receivedBy: 'Nurse Amaka' }),
      /has not been dispatched/
    );
  } finally {
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id] });
  }
});

test('recordReceiptByEnvoId finds the request by its EnVo id and applies the same rules', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { dispatched, envoId } = await dispatchedRequest(user, facility, commodity);

  try {
    const received = await RequestService.recordReceiptByEnvoId(envoId, { receivedBy: 'Nurse Amaka' });
    assert.equal(received.status, 'received');

    const missing = await RequestService.recordReceiptByEnvoId('no-such-envo-id', { receivedBy: 'X' });
    assert.equal(missing, null);
  } finally {
    await dropRequest(dispatched.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('recordReceipt on an unknown request id returns null', async () => {
  const result = await RequestService.recordReceipt(2_147_483_000, { receivedBy: 'X' });
  assert.equal(result, null);
});
