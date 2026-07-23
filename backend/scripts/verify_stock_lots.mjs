// Verify the lot ledger invariant (READ-ONLY): the lots in every bin sum to that
// bin's authoritative balance (stock / dsd_stock / sdp_stock). Reports any bin
// where they disagree, plus a few sanity checks. Run after the seed, and any time
// you want to confirm the ledger hasn't drifted.
//
//   cd C:\envo\app\backend
//   node scripts/verify_stock_lots.mjs

import { pool, query } from '../src/db.js'

const fmt = n => Number(n || 0).toLocaleString()

try {
  // Actual balances per bin, unified from the three balance tables.
  // Lots per bin from stock_lot. Full outer join so we catch a bin with lots but
  // no balance and vice-versa.
  const { rows } = await query(`
    with bal as (
      select facility_id, commodity_id, location_type, '' site, quantity
        from stock where location_type in ('store','dispensary')
      union all select facility_id, commodity_id, 'dsd', dsd_site_name, quantity from dsd_stock
      union all select facility_id, commodity_id, 'sdp', sdp_name,      quantity from sdp_stock
    ),
    lot as (
      select facility_id, commodity_id, location_type, coalesce(site_name,'') site,
             sum(quantity) qty, count(*) lots
        from stock_lot group by 1,2,3,4
    )
    select coalesce(b.facility_id, l.facility_id)   facility_id,
           coalesce(b.commodity_id, l.commodity_id) commodity_id,
           coalesce(b.location_type, l.location_type) location_type,
           coalesce(b.site, l.site)                 site,
           coalesce(b.quantity, 0)                  balance,
           coalesce(l.qty, 0)                       lot_total,
           coalesce(l.lots, 0)                      lots
    from bal b full outer join lot l
      on b.facility_id = l.facility_id and b.commodity_id = l.commodity_id
     and b.location_type = l.location_type and b.site = l.site
    where coalesce(b.quantity,0) <> coalesce(l.qty,0)
  `)

  const [{ bins }] = (await query(`
    select (select count(*) from stock where location_type in ('store','dispensary') and quantity > 0)
         + (select count(*) from dsd_stock where quantity > 0)
         + (select count(*) from sdp_stock where quantity > 0) bins`)).rows
  const [{ lotrows, lotunits }] = (await query('select count(*) lotrows, coalesce(sum(quantity),0) lotunits from stock_lot')).rows
  const [{ neg }] = (await query('select count(*) neg from stock_lot where quantity < 0')).rows
  const [{ noexp }] = (await query('select count(*) noexp from stock_lot where expiry_date is null and quantity > 0')).rows

  console.log('\n══════════ LOT LEDGER VERIFY ══════════\n')
  console.log(`bins with stock         : ${fmt(bins)}`)
  console.log(`lot rows                : ${fmt(lotrows)}  (${fmt(lotunits)} units)`)
  console.log(`negative-quantity lots  : ${fmt(neg)}`)
  console.log(`unknown-expiry lots     : ${fmt(noexp)}  (units the coverage gap put in null-expiry lots)`)
  console.log('')

  if (rows.length === 0) {
    console.log('✓ INVARIANT HOLDS: every bin’s lots sum to its balance.\n')
  } else {
    console.log(`✗ ${fmt(rows.length)} bin(s) where lots ≠ balance:\n`)
    console.table(rows.slice(0, 40).map(r => ({
      facility_id: r.facility_id, commodity_id: r.commodity_id,
      location: r.location_type + (r.site ? `:${r.site}` : ''),
      balance: Number(r.balance), lot_total: Number(r.lot_total), diff: Number(r.balance) - Number(r.lot_total),
    })))
    if (rows.length > 40) console.log(`…and ${rows.length - 40} more.`)
    process.exitCode = 1
  }
} catch (err) {
  console.error('Verify failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
