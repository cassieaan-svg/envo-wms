// POST /api/warehouse-requests — idempotency for the device-to-EnVo leg. The
// EnVo-to-WMS leg (the outbox) was already durable before this; this is what makes
// raising a request safe for the facility's own offline queue to replay, the same
// way dispense/intake/adjustments/transfers already are. See
// docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms sibling project.
//
// Exercised over real HTTP against the mounted router (the module gate and the
// store-manager check both live in the router), matching the pattern in
// commodityListScope.test.js / facilitySnapshot.test.js.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
import { query, pool } from '../src/db.js'
import { attachScope } from '../src/middleware/scope.js'
import { authMiddleware } from '../src/middleware/auth.js'
import warehouseRequestRoutes from '../src/routes/warehouseRequests.js'
import { IdempotencyService } from '../src/services/idempotencyService.js'

let server
test.after(async () => { server?.close(); await pool.end() })

const app = express()
app.use(express.json())
app.use('/api', authMiddleware, attachScope)
app.use('/api/warehouse-requests', warehouseRequestRoutes)
server = app.listen(0)

const PROBE_USER_ID = '00000000-0000-0000-0000-0000000000c1'
const PROBE_EMAIL = `probe-${Date.now()}@envo.ng`
const token = meta => jwt.sign(
  { sub: PROBE_USER_ID, email: PROBE_EMAIL, user_metadata: meta },
  process.env.JWT_SECRET, { expiresIn: '5m' })

// idempotent_operations.actor_user_id is FK'd to users(id), and this suite goes
// through the real HTTP route (unlike the service-level idempotency tests, which
// never pass an actor_user_id at all) — so the probe JWT's `sub` needs a real row.
test.before(async () => {
  await query(
    `insert into users (id, email, encrypted_password, raw_user_meta_data)
     values ($1, $2, 'x', '{}'::jsonb)
     on conflict (id) do update set email = excluded.email`,
    [PROBE_USER_ID, PROBE_EMAIL]
  )
})

async function post(meta, body) {
  const r = await fetch(`http://localhost:${server.address().port}/api/warehouse-requests`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token(meta)}`, 'x-envo-module': 'essential', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 10000)}`
const txnId = (label) => `${label}-${uniq()}`.replace(/[^A-Za-z0-9_-]/g, '-')

async function fixture() {
  const fid = (await query('insert into facilities (name) values ($1) returning id',
    [`T-WR-Fac-${uniq()}`])).rows[0].id
  const cid = (await query(
    `insert into commodities (name, category, unit, module, is_active, unit_price) values ($1,'Consumables','unit','essential',true,500) returning id`,
    [`T-WR-Comm-${uniq()}`])).rows[0].id
  await query(`insert into commodity_modules (commodity_id, module, is_active) values ($1, 'essential', true)`, [cid])
  await query(`insert into facility_modules (facility_id, module) values ($1, 'essential')`, [fid])
  return { fid, cid }
}

async function cleanup({ fid, cid }) {
  await query(`delete from idempotent_operations where facility_id=$1`, [fid]).catch(() => {})
  await query(`delete from warehouse_request_items where request_id in (select id from warehouse_requests where facility_id=$1)`, [fid]).catch(() => {})
  await query(`delete from warehouse_requests where facility_id=$1`, [fid]).catch(() => {})
  await query('delete from commodity_modules where commodity_id=$1', [cid]).catch(() => {})
  await query('delete from commodities where id=$1', [cid]).catch(() => {})
  await query('delete from facility_modules where facility_id=$1', [fid]).catch(() => {})
  await query('delete from facilities where id=$1', [fid]).catch(() => {})
}

function meta(fid) {
  return {
    access_level: 'facility', facility_id: fid, facility_role: 'store_manager',
    commodity_section: 'pharmacy', essential: true,
  }
}

function payload(f, id) {
  return {
    items: [{ commodity_id: f.cid, quantity: 10 }],
    requestedBy: 'Tester', requesterPhone: '08031234567', scheme: 'drf',
    client_txn_id: id,
  }
}

test('a request with a clientTxnId is created once', async () => {
  const f = await fixture()
  const id = txnId('A')
  try {
    const { status, body } = await post(meta(f.fid), payload(f, id))
    assert.equal(status, 200)
    assert.equal(body.data.facility_id, f.fid)
    const { rows } = await query('select count(*)::int n from warehouse_requests where facility_id=$1', [f.fid])
    assert.equal(rows[0].n, 1)
  } finally {
    await cleanup(f)
  }
})

test('retrying the same clientTxnId does not create a second request', async () => {
  const f = await fixture()
  const id = txnId('B')
  const body = payload(f, id)
  try {
    const first = await post(meta(f.fid), body)
    const second = await post(meta(f.fid), body)
    assert.equal(first.body.data.id, second.body.data.id, 'the retry is answered with the original request, not a new one')
    const { rows } = await query('select count(*)::int n from warehouse_requests where facility_id=$1', [f.fid])
    assert.equal(rows[0].n, 1, 'only one request exists')
  } finally {
    await cleanup(f)
  }
})

test('two concurrent submits with the same clientTxnId still only create one request', async () => {
  const f = await fixture()
  const id = txnId('C')
  const body = payload(f, id)
  try {
    const [a, b] = await Promise.all([post(meta(f.fid), body), post(meta(f.fid), body)])
    assert.equal(a.body.data.id, b.body.data.id)
    const { rows } = await query('select count(*)::int n from warehouse_requests where facility_id=$1', [f.fid])
    assert.equal(rows[0].n, 1)
  } finally {
    await cleanup(f)
  }
})

test('a different clientTxnId is a genuinely new request', async () => {
  const f = await fixture()
  try {
    const first = await post(meta(f.fid), payload(f, txnId('D1')))
    const second = await post(meta(f.fid), payload(f, txnId('D2')))
    assert.notEqual(first.body.data.id, second.body.data.id)
    const { rows } = await query('select count(*)::int n from warehouse_requests where facility_id=$1', [f.fid])
    assert.equal(rows[0].n, 2)
  } finally {
    await cleanup(f)
  }
})

test('a request with no clientTxnId still works, unchanged, for the existing online client', async () => {
  const f = await fixture()
  try {
    const { status, body } = await post(meta(f.fid), {
      items: [{ commodity_id: f.cid, quantity: 5 }],
      requestedBy: 'Tester', requesterPhone: '08031234567', scheme: 'drf',
    })
    assert.equal(status, 200)
    assert.ok(body.data.id)
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
    const { status, body } = await post(meta(f.fid), payload(f, id))
    assert.equal(status, 409)
    assert.match(body.error, /different operation/)
  } finally {
    await cleanup(f)
  }
})

test('a malformed clientTxnId is refused with a 400', async () => {
  const f = await fixture()
  try {
    const { status, body } = await post(meta(f.fid), payload(f, 'nope'))
    assert.equal(status, 400)
    assert.match(body.error, /client_txn_id/)
  } finally {
    await cleanup(f)
  }
})
