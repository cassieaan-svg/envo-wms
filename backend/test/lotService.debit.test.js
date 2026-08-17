import test from 'node:test'
import assert from 'node:assert/strict'
import { withTransaction, query } from '../src/db.js'
import { LotService } from '../src/services/lotService.js'

// make unique names per run to avoid unique-constraint collisions
const uniq = () => `${Date.now()}-${Math.floor(Math.random()*10000)}`

// Remove a test's fixture rows, CHILDREN FIRST. stock_lot references both the
// commodity and the facility, so leaving its rows behind makes the parent deletes
// fail on the foreign key — and because these ran as best-effort catches, the
// failure was silent and every run leaked a facility, a commodity and a lot into
// the dev database. Those strays then showed up as real stock in category audits.
//
// Errors are reported rather than swallowed: a cleanup that cannot clean up is
// something to see, not to hide.
async function cleanup({ fid, cid, stockId }) {
  const steps = [
    ['stock_lot', 'delete from stock_lot where facility_id = $1 and commodity_id = $2', [fid, cid]],
    ['stock', 'delete from stock where id = $1', [stockId]],
    ['facility', 'delete from facilities where id = $1', [fid]],
    ['commodity', 'delete from commodities where id = $1', [cid]],
  ]
  for (const [label, sql, params] of steps) {
    try { await query(sql, params) }
    catch (err) { console.warn(`[cleanup] ${label} not removed: ${err.message}`) }
  }
}

// Unit tests for LotService.debit enforcement behaviors

test('debit with specific batch and enforce=true throws when batch short', async () => {
  // Setup fixture committed so debit's exec can see it
  const fname = `T-Lot-Enforce-${uniq()}`
  const f = await query('insert into facilities (name) values ($1) returning id', [fname])
  const fid = f.rows[0].id
  const cname = `T-Lot-Comm-${uniq()}`
  const c = await query('insert into commodities (name, category, unit) values ($1,$2,$3) returning id', [cname, 'pharmacy', 'u'])
  const cid = c.rows[0].id
  const s = await query('insert into stock (facility_id, commodity_id, quantity, location_type, updated_at) values ($1,$2,$3,\'store\', now()) returning id', [fid, cid, 100])
  const stockId = s.rows[0].id

  // Seed one small lot A (10)
  await withTransaction(async exec => {
    await LotService.credit(exec, { facility_id: fid, commodity_id: cid, location_type: 'store' }, { batch: 'A', expiry: null, qty: 10 })
  })

  try {
    await assert.rejects(
      async () => {
        await withTransaction(async exec => {
          await LotService.debit(exec, { facility_id: fid, commodity_id: cid, location_type: 'store' }, 50, { batch: 'A', enforce: true })
        })
      },
      err => err && err.status === 409
    )
  } finally {
    await cleanup({ fid, cid, stockId })
  }
})

test('debit non-enforced returns shortfall when insufficient', async () => {
  const fname = `T-Lot-Short-${uniq()}`
  const f = await query('insert into facilities (name) values ($1) returning id', [fname])
  const fid = f.rows[0].id
  const cname = `T-Lot-Comm2-${uniq()}`
  const c = await query('insert into commodities (name, category, unit) values ($1,$2,$3) returning id', [cname, 'pharmacy', 'u'])
  const cid = c.rows[0].id
  const s = await query('insert into stock (facility_id, commodity_id, quantity, location_type, updated_at) values ($1,$2,$3,\'store\', now()) returning id', [fid, cid, 20])
  const stockId = s.rows[0].id

  // Seed lot with 10 units
  await withTransaction(async exec => {
    await LotService.credit(exec, { facility_id: fid, commodity_id: cid, location_type: 'store' }, { batch: 'X', expiry: null, qty: 10 })
  })

  try {
    await withTransaction(async exec => {
      const res = await LotService.debit(exec, { facility_id: fid, commodity_id: cid, location_type: 'store' }, 15, { enforce: false })
      assert.equal(Array.isArray(res.drawn), true)
      const drawnQty = res.drawn.reduce((s, l) => s + l.qty, 0)
      assert.equal(drawnQty, 10)
      assert.equal(res.shortfall, 5)
    })
  } finally {
    await cleanup({ fid, cid, stockId })
  }
})
