import test from 'node:test'
import assert from 'node:assert/strict'
import { withTransaction, query } from '../src/db.js'
import { LotService } from '../src/services/lotService.js'

// make unique names per run to avoid unique-constraint collisions
const uniq = () => `${Date.now()}-${Math.floor(Math.random()*10000)}`

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
    await query('delete from stock where id = $1', [stockId]).catch(() => {})
    await query('delete from facilities where id = $1', [fid]).catch(() => {})
    await query('delete from commodities where id = $1', [cid]).catch(() => {})
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
    await query('delete from stock where id = $1', [stockId]).catch(() => {})
    await query('delete from facilities where id = $1', [fid]).catch(() => {})
    await query('delete from commodities where id = $1', [cid]).catch(() => {})
  }
})
