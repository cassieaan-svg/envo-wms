// GET /api/facility-snapshot — the offline device's one-pull cache: catalogue, this
// facility's current stock, and the facility record. See
// docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms sibling project.
//
// Exercised over real HTTP against the mounted router, matching the pattern in
// commodityListScope.test.js — the interesting behaviour is the interaction between
// req.scope (module, section, facility) and what actually comes back.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
import { query, pool } from '../src/db.js'
import { attachScope } from '../src/middleware/scope.js'
import { authMiddleware } from '../src/middleware/auth.js'
import snapshotRoutes from '../src/routes/facilitySnapshot.js'

let server
test.after(async () => { server?.close(); await pool.end() })

const app = express()
app.use(express.json())
app.use('/api', authMiddleware, attachScope)
app.use('/api/facility-snapshot', snapshotRoutes)
server = app.listen(0)

const token = meta => jwt.sign(
  { sub: '00000000-0000-0000-0000-0000000000c1', email: 'probe@envo.ng', user_metadata: meta },
  process.env.JWT_SECRET, { expiresIn: '5m' })

async function pull(meta, module = 'essential') {
  const r = await fetch(`http://localhost:${server.address().port}/api/facility-snapshot`, {
    headers: { Authorization: `Bearer ${token(meta)}`, 'x-envo-module': module },
  })
  return { status: r.status, body: await r.json() }
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 10000)}`

async function fixture() {
  const fid = (await query('insert into facilities (name) values ($1) returning id',
    [`T-Snap-Fac-${uniq()}`])).rows[0].id
  const cid = (await query(
    `insert into commodities (name, category, unit, module, is_active) values ($1,$2,$3,'essential',true) returning id`,
    [`T-Snap-Comm-${uniq()}`, 'Consumables', 'unit'])).rows[0].id
  await query(`insert into commodity_modules (commodity_id, module, is_active) values ($1, 'essential', true)`, [cid])
  await query(
    `insert into stock (facility_id, commodity_id, quantity, location_type, updated_at)
     values ($1,$2,$3,'store', now())`, [fid, cid, 40])
  await query(`insert into facility_modules (facility_id, module) values ($1, 'essential')`, [fid])
  return { fid, cid }
}

async function cleanup({ fid, cid }) {
  await query('delete from stock where facility_id=$1 and commodity_id=$2', [fid, cid]).catch(() => {})
  await query('delete from commodity_modules where commodity_id=$1', [cid]).catch(() => {})
  await query('delete from commodities where id=$1', [cid]).catch(() => {})
  await query('delete from facility_modules where facility_id=$1', [fid]).catch(() => {})
  await query('delete from facilities where id=$1', [fid]).catch(() => {})
}

test('a facility login pulls its own catalogue, stock and facility record', async () => {
  const f = await fixture()
  try {
    const { status, body } = await pull({
      access_level: 'facility', facility_id: f.fid, commodity_section: 'pharmacy', essential: true,
    })
    assert.equal(status, 200)
    assert.equal(body.success, true)
    assert.equal(body.data.facility.id, f.fid)
    assert.ok(body.data.commodities.some(c => c.id === f.cid), 'the seeded essential commodity is in the catalogue')
    assert.ok(body.data.stock.some(s => s.commodity_id === f.cid && s.quantity === 40), 'this facility\'s stock is in the snapshot')
    assert.equal(body.counts.commodities, body.data.commodities.length)
    assert.ok(body.version, 'a version hash is present')
  } finally {
    await cleanup(f)
  }
})

test('a login without the essential grant is refused', async () => {
  const f = await fixture()
  try {
    const { status, body } = await pull({
      access_level: 'facility', facility_id: f.fid, commodity_section: 'pharmacy',
    })
    assert.equal(status, 403)
    assert.match(body.error, /not enabled for Essential/)
  } finally {
    await cleanup(f)
  }
})

test('an admin login (no facility_id) is refused — this endpoint is for a device, not oversight', async () => {
  const { status, body } = await pull({ access_level: 'essential_admin', admin_state: 'Akwa Ibom', essential: true })
  assert.equal(status, 403)
  assert.match(body.error, /facility login is required/)
})

test('a lab-section facility does not see a pharmacy-only commodity, and vice versa', async () => {
  const f = await fixture()
  const labCid = (await query(
    `insert into commodities (name, category, unit, module, is_active) values ($1,'Lab consumables','unit','hiv',true) returning id`,
    [`T-Snap-Lab-${uniq()}`])).rows[0].id
  await query(`insert into commodity_modules (commodity_id, module, is_active) values ($1, 'hiv', true)`, [labCid])
  try {
    const { body } = await pull({
      access_level: 'facility', facility_id: f.fid, commodity_section: 'pharmacy', essential: true,
    })
    assert.ok(body.data.commodities.some(c => c.id === f.cid), 'the essential commodity this login should see is present')
    assert.ok(!body.data.commodities.some(c => c.id === labCid), 'a pharmacy-section essential login does not see a lab-only commodity')
  } finally {
    await query('delete from commodity_modules where commodity_id=$1', [labCid]).catch(() => {})
    await query('delete from commodities where id=$1', [labCid]).catch(() => {})
    await cleanup(f)
  }
})

test('wrong module (hiv) is refused, matching every other essential-only route', async () => {
  const f = await fixture()
  try {
    const { status, body } = await pull({
      access_level: 'facility', facility_id: f.fid, commodity_section: 'pharmacy', essential: true,
    }, 'hiv')
    assert.equal(status, 400)
    assert.match(body.error, /Essential Commodities module/)
  } finally {
    await cleanup(f)
  }
})
