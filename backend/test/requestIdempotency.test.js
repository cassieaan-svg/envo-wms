// markPicking and reject previously accepted no clientTxnId, despite each triggering a real
// EnVo-bound side effect (a status_event that syncs to Cloud and, from there, an EnVo
// callback) — a retried call (a flaky connection, a double-tap) could raise the same
// transition twice. This covers the fix: both now require clientTxnId, exactly like fulfil,
// and a replay returns the original result unchanged rather than erroring or double-recording.

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import pool, { query } from '../src/db.js';
import { RequestService } from '../src/services/requestService.js';
import { makeUser, makeFacility, makeCommodity, cleanup, txnId } from './helpers.js';

process.env.OUTBOX_WORKER = 'off';
process.env.PORT = '0';
const { default: app } = await import('../src/server.js');

let server, base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

const tokenFor = (user) =>
  jwt.sign({ sub: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET);
async function httpReq(method, path, { body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function makeRequest(facility, commodity, quantity = 50) {
  const envoId = `RIDEM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  await query("DELETE FROM outbox WHERE payload->>'envoRequestId' = $1", [envoId]);
  await query('DELETE FROM requests WHERE id = $1', [requestId]);
  if (commodityId) await query('DELETE FROM commodity_prices WHERE commodity_id = $1', [commodityId]);
}

test('markPicking replays the same result for a repeated clientTxnId, not a second event', async () => {
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { req, envoId } = await makeRequest(facility, commodity);
  const id = txnId('PICK');

  try {
    const first = await RequestService.markPicking(req.id, { pickedBy: 'Officer A', clientTxnId: id });
    const second = await RequestService.markPicking(req.id, { pickedBy: 'Officer B', clientTxnId: id });

    assert.equal(second.picked_by, first.picked_by, 'the replay is the original result, not a re-application with the new name');

    const { rows: events } = await query(
      `SELECT status FROM request_status_events WHERE request_id = $1`, [req.id]);
    assert.equal(events.length, 1, 'only one picking event was recorded');
  } finally {
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id] });
  }
});

test('a genuinely new markPicking call needs its own clientTxnId — reusing one for a different request is refused', async () => {
  const facility = await makeFacility();
  const commodityA = await makeCommodity();
  const commodityB = await makeCommodity();
  const { req: reqA, envoId: envoA } = await makeRequest(facility, commodityA);
  const { req: reqB, envoId: envoB } = await makeRequest(facility, commodityB);
  const id = txnId('PICK-XU');

  try {
    await RequestService.markPicking(reqA.id, { pickedBy: 'Officer A', clientTxnId: id });
    // Same operation type, but this id already names a transaction that did NOT touch
    // reqB — IdempotencyService.claim serves back the original result for the SAME
    // logical transaction; requesting reqB under the same id is simply the original
    // request replayed, which never picked reqB — so reqB stays pending.
    const replay = await RequestService.markPicking(reqB.id, { pickedBy: 'Officer A', clientTxnId: id });
    assert.equal(replay.id, reqA.id, 'the id names the first transaction, not whichever request is passed');

    const { rows } = await query('SELECT status FROM requests WHERE id = $1', [reqB.id]);
    assert.equal(rows[0].status, 'pending', 'the second request was never actually touched');
  } finally {
    await dropRequest(reqA.id, envoA, commodityA.id);
    await dropRequest(reqB.id, envoB, commodityB.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodityA.id, commodityB.id] });
  }
});

test('reject replays the same result for a repeated clientTxnId, not a second cancellation', async () => {
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { req, envoId } = await makeRequest(facility, commodity);
  const id = txnId('REJ');

  try {
    const first = await RequestService.reject(req.id, { rejectedBy: 'Officer A', reason: 'no stock', clientTxnId: id });
    const second = await RequestService.reject(req.id, { rejectedBy: 'Officer B', reason: 'different reason', clientTxnId: id });

    assert.equal(second.notes, first.notes, 'the replay is the original result, not a re-application');

    const { rows: events } = await query(
      `SELECT status FROM request_status_events WHERE request_id = $1`, [req.id]);
    assert.equal(events.length, 1, 'only one rejection event was recorded');
  } finally {
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id] });
  }
});

test('PATCH /:id/picking over HTTP is refused without a clientTxnId', async () => {
  const user = await makeUser({ roles: ['picker_dispatcher'] });
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { req, envoId } = await makeRequest(facility, commodity);
  const token = tokenFor(user);

  try {
    const res = await httpReq('PATCH', `/api/requests/${req.id}/picking`, {
      body: { pickedBy: 'Officer A' }, token,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /clientTxnId is required/);

    const { rows } = await query('SELECT status FROM requests WHERE id = $1', [req.id]);
    assert.equal(rows[0].status, 'pending', 'nothing changed');
  } finally {
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('POST /:id/reject over HTTP is refused without a clientTxnId', async () => {
  const user = await makeUser({ roles: ['picker_dispatcher'] });
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { req, envoId } = await makeRequest(facility, commodity);
  const token = tokenFor(user);

  try {
    const res = await httpReq('POST', `/api/requests/${req.id}/reject`, {
      body: { reason: 'no stock' }, token,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /clientTxnId is required/);
  } finally {
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id], userIds: [user.id] });
  }
});

test('reject without a clientTxnId still works when called directly (service level has no hard requirement)', async () => {
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const { req, envoId } = await makeRequest(facility, commodity);

  try {
    const rejected = await RequestService.reject(req.id, { rejectedBy: 'Officer A', reason: 'no stock' });
    assert.equal(rejected.status, 'rejected');
  } finally {
    await dropRequest(req.id, envoId, commodity.id);
    await cleanup({ facilityIds: [facility.id], commodityIds: [commodity.id] });
  }
});
