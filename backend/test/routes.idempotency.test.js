// Phase 1 — the HTTP surface.
//
// The service tests prove the mechanism; this proves it is actually WIRED. The route layer
// is where clientTxnId is read off the body, validated, and paired with the authenticated
// user — and a mistake there (reading the wrong field, passing the wrong id) would leave
// every service test passing while production had no protection at all.
//
// Runs the real Express app over a real socket with a real JWT, so authentication,
// requireAdmin and the router all take part.

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import pool from '../src/db.js';
import {
  makeUser, makeFacility, makeCommodity, makeBatch,
  batchQuantity, movementsFor, cleanup, txnId, scheme,
} from './helpers.js';

process.env.OUTBOX_WORKER = 'off';   // set before the app is imported; no callbacks from a test
process.env.PORT = '0';              // let the OS choose a free port

const { default: app } = await import('../src/server.js');

let server;
let base;

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

async function post(path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('POST dispatch-orders: a retried request over HTTP issues the stock once', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const token = tokenFor(user);
  const id = txnId('HTTP');
  const body = {
    items: [{ commodityId: commodity.id, quantity: 120, unitPrice: 10 }],
    scheme: await scheme(),
    dispatchedBy: 'Store Officer',
    clientTxnId: id,
  };

  try {
    const first = await post(`/api/facilities/${facility.id}/dispatch-orders`, body, token);
    assert.equal(first.status, 201, 'the dispatch was accepted');

    // The reply never arrived; the officer presses Save again with the same id.
    const second = await post(`/api/facilities/${facility.id}/dispatch-orders`, body, token);
    assert.equal(second.status, 201);
    assert.equal(second.body.id, first.body.id, 'the retry is answered with the original order');

    assert.equal(await batchQuantity(batch.id), 380, 'stock left the shelf once');
    assert.equal((await movementsFor(batch.id, 'dispatch')).length, 1, 'one movement only');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id], clientTxnIds: [id] });
  }
});

test('POST dispatch-orders: a malformed clientTxnId is a 400 and moves nothing', async () => {
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const token = tokenFor(user);

  try {
    const res = await post(`/api/facilities/${facility.id}/dispatch-orders`, {
      items: [{ commodityId: commodity.id, quantity: 10, unitPrice: 1 }],
      scheme: await scheme(),
      dispatchedBy: 'Store Officer',
      clientTxnId: 'nope',
    }, token);

    assert.equal(res.status, 400);
    assert.match(res.body.error, /8-64 characters/);
    assert.equal(await batchQuantity(batch.id), 500, 'nothing moved');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id] });
  }
});

test('POST dispatch-orders: another user cannot replay someone else\'s transaction id', async () => {
  const owner = await makeUser();
  const stranger = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);
  const id = txnId('HTTPSEC');
  const s = await scheme();
  const body = {
    items: [{ commodityId: commodity.id, quantity: 100, unitPrice: 1 }],
    scheme: s, dispatchedBy: 'Owner', clientTxnId: id,
  };

  try {
    const first = await post(`/api/facilities/${facility.id}/dispatch-orders`, body, tokenFor(owner));
    assert.equal(first.status, 201);

    const stolen = await post(`/api/facilities/${facility.id}/dispatch-orders`,
      { ...body, dispatchedBy: 'Stranger' }, tokenFor(stranger));

    assert.equal(stolen.status, 409, 'refused, not replayed');
    assert.match(stolen.body.error, /another user/i);
    assert.ok(!('items' in (stolen.body || {})), 'no part of the original order was disclosed');
    assert.equal(await batchQuantity(batch.id), 400, 'the refusal moved no stock');
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [owner.id, stranger.id], clientTxnIds: [id] });
  }
});

test('POST dispatch-orders: a request with NO clientTxnId is refused outright', async () => {
  // Phase 2 made the id mandatory. This is the assertion that stops it quietly becoming
  // optional again: a caller that omits it must be told, not silently unprotected.
  const user = await makeUser();
  const facility = await makeFacility();
  const commodity = await makeCommodity();
  const batch = await makeBatch(commodity.id, 500);

  try {
    const res = await post(`/api/facilities/${facility.id}/dispatch-orders`, {
      items: [{ commodityId: commodity.id, quantity: 10, unitPrice: 1 }],
      scheme: await scheme(),
      dispatchedBy: 'Store Officer',
      // no clientTxnId
    }, tokenFor(user));

    assert.equal(res.status, 400);
    assert.match(res.body.error, /clientTxnId is required/);
    assert.equal(await batchQuantity(batch.id), 500, 'nothing moved');
    assert.equal((await movementsFor(batch.id, 'dispatch')).length, 0);
  } finally {
    await cleanup({ batchIds: [batch.id], commodityIds: [commodity.id], facilityIds: [facility.id], userIds: [user.id] });
  }
});

test('unauthenticated requests never reach the idempotency layer', async () => {
  const id = txnId('ANON');
  const res = await fetch(`${base}/api/facilities/1/dispatch-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [], clientTxnId: id }),
  });
  assert.equal(res.status, 401);

  // Scoped to THIS id, not a count of the whole table: the test files run in parallel, so
  // other tests legitimately have transactions in flight. What matters is that the id the
  // anonymous caller offered was never claimed.
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int c FROM inventory_transactions WHERE client_txn_id = $1', [id]);
  assert.equal(rows[0].c, 0, 'an anonymous caller claimed no transaction identity');
});
