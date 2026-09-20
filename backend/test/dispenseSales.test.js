import test from 'node:test'
import assert from 'node:assert/strict'
import { query } from '../src/db.js'
import { LogService } from '../src/services/logService.js'

// Sales: how much a facility has SOLD (dispensed at a snapshotted unit price), the
// counterpart to how much it has bought (warehouse_requests). unit_price/line_total
// are snapshotted at record time so a later catalogue price change never rewrites a
// past sale's reported value — see the migration comment
// (db/migrations/20260920_dispense_sale_price.sql) and LogService.recordDispense.

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 10000)}`

async function fixture({ unitPrice = 9, stockQty = 1000 } = {}) {
  const fid = (await query('insert into facilities (name) values ($1) returning id',
    [`T-Sales-Fac-${uniq()}`])).rows[0].id
  const cid = (await query(
    'insert into commodities (name, category, unit, unit_price) values ($1,$2,$3,$4) returning id',
    [`T-Sales-Comm-${uniq()}`, 'Consumables', 'pack', unitPrice])).rows[0].id
  // A second, unpriced commodity — HIV-shaped, no catalogue price at all.
  const cidUnpriced = (await query(
    'insert into commodities (name, category, unit) values ($1,$2,$3) returning id',
    [`T-Sales-Unpriced-${uniq()}`, 'Pharmacy drugs', 'tab'])).rows[0].id
  await query(
    `insert into stock (facility_id, commodity_id, quantity, location_type, updated_at)
     values ($1,$2,$3,'dispensary', now())`, [fid, cid, stockQty])
  await query(
    `insert into stock (facility_id, commodity_id, quantity, location_type, updated_at)
     values ($1,$2,$3,'dispensary', now())`, [fid, cidUnpriced, stockQty])
  return { fid, cid, cidUnpriced }
}

async function cleanup({ fid, cid, cidUnpriced }) {
  for (const sql of [
    'delete from stock_lot where facility_id=$1 and commodity_id in ($2,$3)',
    'delete from dispense_log where facility_id=$1 and commodity_id in ($2,$3)',
    'delete from stock where facility_id=$1 and commodity_id in ($2,$3)',
  ]) await query(sql, [fid, cid, cidUnpriced]).catch(() => {})
  await query('delete from facilities where id=$1', [fid]).catch(() => {})
  await query('delete from commodities where id in ($1,$2)', [cid, cidUnpriced]).catch(() => {})
}

test('recordDispense snapshots unit_price and computes line_total for a priced commodity', async () => {
  const f = await fixture({ unitPrice: 9 })
  try {
    const result = await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 30, dispensed_by: 'tester', location_type: 'dispensary',
    })
    assert.equal(Number(result.unit_price), 9)
    assert.equal(Number(result.line_total), 270)
  } finally {
    await cleanup(f)
  }
})

test('recordDispense leaves unit_price/line_total null for a commodity with no catalogue price', async () => {
  const f = await fixture()
  try {
    const result = await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cidUnpriced, quantity: 10, dispensed_by: 'tester', location_type: 'dispensary',
    })
    assert.equal(result.unit_price, null)
    assert.equal(result.line_total, null)
  } finally {
    await cleanup(f)
  }
})

test('a later catalogue price change does not rewrite an already-recorded sale', async () => {
  const f = await fixture({ unitPrice: 9 })
  try {
    const first = await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 10, dispensed_by: 'tester', location_type: 'dispensary',
    })
    assert.equal(Number(first.line_total), 90)

    await query('update commodities set unit_price = 50 where id = $1', [f.cid])

    const { rows } = await query('select unit_price, line_total from dispense_log where id = $1', [first.id])
    assert.equal(Number(rows[0].unit_price), 9, 'the historical row keeps its original snapshot')
    assert.equal(Number(rows[0].line_total), 90)
  } finally {
    await cleanup(f)
  }
})

test('editing quantity recomputes line_total from the FROZEN unit_price, not a live one', async () => {
  const f = await fixture({ unitPrice: 9 })
  try {
    const original = await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 10, dispensed_by: 'tester', location_type: 'dispensary',
    })
    await query('update commodities set unit_price = 50 where id = $1', [f.cid])

    const updated = await LogService.updateLog('dispense', original.id, { quantity: 20, edited_by: 'tester' })
    assert.equal(Number(updated.unit_price), 9, 'unit_price is untouched by the edit')
    assert.equal(Number(updated.line_total), 180, '20 * the ORIGINAL 9, not the now-live 50')
  } finally {
    await cleanup(f)
  }
})

test('getSalesSummary grouped by commodity: sums quantity and revenue, excludes the unpriced commodity', async () => {
  const f = await fixture({ unitPrice: 9 })
  try {
    await LogService.recordDispense({ facility_id: f.fid, commodity_id: f.cid, quantity: 10, dispensed_by: 'a', location_type: 'dispensary' })
    await LogService.recordDispense({ facility_id: f.fid, commodity_id: f.cid, quantity: 5, dispensed_by: 'b', location_type: 'dispensary' })
    await LogService.recordDispense({ facility_id: f.fid, commodity_id: f.cidUnpriced, quantity: 100, dispensed_by: 'c', location_type: 'dispensary' })

    const rows = await LogService.getSalesSummary(f.fid, { groupBy: 'commodity' })
    assert.equal(rows.length, 1, 'only the priced commodity produces a row')
    assert.equal(rows[0].key, f.cid)
    assert.equal(Number(rows[0].quantity), 15)
    assert.equal(Number(rows[0].revenue), 135)
    assert.equal(Number(rows[0].txn), 2)
  } finally {
    await cleanup(f)
  }
})

test('getSalesSummary grouped by facility', async () => {
  const f = await fixture({ unitPrice: 9 })
  try {
    await LogService.recordDispense({ facility_id: f.fid, commodity_id: f.cid, quantity: 10, dispensed_by: 'a', location_type: 'dispensary' })
    const rows = await LogService.getSalesSummary(f.fid, { groupBy: 'facility' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].key, f.fid)
    assert.equal(Number(rows[0].revenue), 90)
  } finally {
    await cleanup(f)
  }
})

test('getSalesSummary respects a from/to date window', async () => {
  const f = await fixture({ unitPrice: 9 })
  try {
    await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 10, dispensed_by: 'a', location_type: 'dispensary',
      dispensed_at: '2020-01-01T00:00:00Z',
    })
    await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 5, dispensed_by: 'b', location_type: 'dispensary',
      dispensed_at: new Date().toISOString(),
    })
    const rows = await LogService.getSalesSummary(f.fid, { groupBy: 'commodity', from: '2025-01-01' })
    assert.equal(Number(rows[0].quantity), 5, 'the 2020 dispense falls outside the window')
  } finally {
    await cleanup(f)
  }
})

test('getSalesSummary includes a sale recorded LATER on the `to` day itself (not just up to midnight)', async () => {
  const f = await fixture({ unitPrice: 9 })
  try {
    await LogService.recordDispense({
      facility_id: f.fid, commodity_id: f.cid, quantity: 3, dispensed_by: 'a', location_type: 'dispensary',
      dispensed_at: new Date().toISOString(),
    })
    const today = new Date().toISOString().slice(0, 10)
    const rows = await LogService.getSalesSummary(f.fid, { groupBy: 'commodity', from: today, to: today })
    assert.equal(rows.length, 1, 'a same-day sale is not excluded by the `to` bound')
    assert.equal(Number(rows[0].quantity), 3)
  } finally {
    await cleanup(f)
  }
})

test('getSalesSummary rejects an unknown group_by', async () => {
  const f = await fixture()
  try {
    await assert.rejects(
      LogService.getSalesSummary(f.fid, { groupBy: 'not-a-real-grouping' }),
      /Unsupported group_by/
    )
  } finally {
    await cleanup(f)
  }
})
