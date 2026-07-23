// Lot-ledger coverage report (READ-ONLY — writes no data).
//
// Before seeding a per-batch lot ledger we need to know how much current on-hand
// stock can be backed by a REAL expiry date from what's already recorded, and how
// much has no expiry and would need a physical stock-take entry.
//
// For each (facility, commodity) it compares:
//   on_hand   = units currently held across ALL locations (store + dispensary +
//               DSD sites + SDP sites)
//   backed    = units that can be given a real expiry, i.e. min(on_hand, sum of
//               receipts — intakes + increase-adjustments — that recorded an
//               expiry_date). Receipt history normally exceeds on-hand, so this is
//               full coverage unless stock exists beyond what was ever recorded
//               with an expiry.
//   gap       = on_hand − backed  → the units with NO expiry to attach (the
//               stock-take worklist).
//
// It does NOT compute the per-batch split (that's the seed's job); it only answers
// "can every on-hand unit be given a real expiry from existing records?".
//
// Run ON THE VM (psql is not on PATH there), from the backend dir so dotenv reads
// the live .env:
//   cd C:\envo\app\backend
//   node scripts/lot_ledger_coverage.mjs
//
// Prints an overall summary + a per-facility table, and writes the full
// (facility, commodity) breakdown to lot_coverage_report.csv in the current dir.

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pool, query } from '../src/db.js'

const fmt = n => Number(n || 0).toLocaleString()
const pct = (a, b) => b > 0 ? Math.round((a / b) * 1000) / 10 : 100

try {
  // On-hand per (facility, commodity), summed across every stock bucket.
  // Total received-with-expiry and total received per (facility, commodity),
  // from intakes plus increase-adjustments (both carry batch_number/expiry_date).
  const { rows } = await query(`
    with onhand as (
      select facility_id, commodity_id, sum(q) qty from (
        select facility_id, commodity_id, quantity q from stock
        union all select facility_id, commodity_id, quantity from dsd_stock
        union all select facility_id, commodity_id, quantity from sdp_stock
      ) s group by facility_id, commodity_id
    ),
    receipts as (
      -- Every channel that ADDS stock to a facility, with the batch/expiry it
      -- carried: intakes, increase-adjustments, and accepted external
      -- redistributions IN (whose batch/expiry live in the transfer notes, not
      -- their own columns). Internal / DSD / SDP moves only shift stock between a
      -- facility's own locations, so they add nothing to the facility total.
      select facility_id, commodity_id,
             sum(quantity) filter (where exp_txt is not null and exp_txt <> '')                      qty_with_expiry,
             sum(quantity)                                                                           qty_all,
             count(*)      filter (where exp_txt   is not null and exp_txt   <> '' and quantity > 0)  lots_with_expiry,
             count(*)      filter (where batch_txt is not null and batch_txt <> '' and quantity > 0)  lots_with_batch
      from (
        select facility_id, commodity_id, quantity,
               batch_number batch_txt, expiry_date::text exp_txt
          from intake_log
        union all
        select facility_id, commodity_id, quantity,
               batch_number, expiry_date::text
          from stock_adjustment_log where adjustment_type = 'Increase'
        union all
        select receiving_facility_id, commodity_id, quantity,
               substring(notes from '\\[Batch:\\s*([^\\]]+)\\]'),
               substring(notes from '\\[Expiry:\\s*([^\\]]+)\\]')
          from stock_transfer_log
         where status = 'accepted'
           and sending_facility_id is not null and receiving_facility_id is not null
           and sending_facility_id <> receiving_facility_id
           and coalesce(notes,'') !~ '\\[Internal:'
           and coalesce(notes,'') !~ '\\[DSD:'
           and coalesce(notes,'') !~ '\\[SDP:'
      ) r group by facility_id, commodity_id
    )
    select f.name  facility, f.state, f.lga,
           c.name  commodity, c.category,
           o.qty                              on_hand,
           coalesce(r.qty_with_expiry, 0)     qty_with_expiry,
           coalesce(r.qty_all, 0)             qty_all_receipts,
           coalesce(r.lots_with_expiry, 0)    lots_with_expiry,
           coalesce(r.lots_with_batch, 0)     lots_with_batch
    from onhand o
    join facilities  f on f.id = o.facility_id
    join commodities c on c.id = o.commodity_id
    left join receipts r on r.facility_id = o.facility_id and r.commodity_id = o.commodity_id
    where o.qty > 0
    order by f.state, f.lga, f.name, c.name
  `)

  // Per-row coverage.
  const detail = rows.map(r => {
    const onHand = Number(r.on_hand) || 0
    const backed = Math.min(onHand, Number(r.qty_with_expiry) || 0)
    const gap = Math.max(0, onHand - backed)
    return {
      state: r.state || '', lga: r.lga || '', facility: r.facility, commodity: r.commodity,
      category: r.category || '', on_hand: onHand, backed, gap,
      lots_with_expiry: Number(r.lots_with_expiry) || 0,
      lots_with_batch: Number(r.lots_with_batch) || 0,
      status: gap === 0 ? 'covered' : backed === 0 ? 'no-expiry' : 'partial',
    }
  })

  // ---- Overall summary ----
  const tot = detail.reduce((a, d) => {
    a.units += d.on_hand; a.backed += d.backed; a.gap += d.gap
    a[d.status]++; a.lines++
    return a
  }, { units: 0, backed: 0, gap: 0, covered: 0, partial: 0, 'no-expiry': 0, lines: 0 })

  console.log('\n══════════ LOT-LEDGER COVERAGE ══════════\n')
  console.log(`Stocked (facility × commodity) lines : ${fmt(tot.lines)}`)
  console.log(`  fully covered (real expiry)        : ${fmt(tot.covered)}`)
  console.log(`  partial (some units no expiry)     : ${fmt(tot.partial)}`)
  console.log(`  no expiry at all                   : ${fmt(tot['no-expiry'])}`)
  console.log('')
  console.log(`On-hand units                        : ${fmt(tot.units)}`)
  console.log(`  backed by a real expiry            : ${fmt(tot.backed)}  (${pct(tot.backed, tot.units)}%)`)
  console.log(`  GAP — need a physical expiry entry : ${fmt(tot.gap)}  (${pct(tot.gap, tot.units)}%)`)

  // ---- Per-facility breakdown ----
  const byFac = {}
  for (const d of detail) {
    const k = `${d.state} · ${d.lga} · ${d.facility}`
    const f = byFac[k] ||= { lines: 0, units: 0, backed: 0, gap: 0, gapLines: 0 }
    f.lines++; f.units += d.on_hand; f.backed += d.backed; f.gap += d.gap
    if (d.gap > 0) f.gapLines++
  }
  const facRows = Object.entries(byFac)
    .map(([facility, v]) => ({
      facility, lines: v.lines, gap_lines: v.gapLines,
      on_hand: v.units, gap_units: v.gap, pct_covered: pct(v.backed, v.units),
    }))
    .sort((a, b) => b.gap_units - a.gap_units)

  console.log('\n──────── Per facility (worst gaps first) ────────\n')
  console.table(facRows.slice(0, 40))
  if (facRows.length > 40) console.log(`…and ${facRows.length - 40} more facilities (see CSV).`)

  // ---- CSV: the full worklist ----
  const esc = v => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = ['state', 'lga', 'facility', 'commodity', 'category', 'on_hand', 'backed_with_expiry', 'gap_no_expiry', 'lots_with_expiry', 'lots_with_batch', 'status']
  const csv = [header.join(',')]
    .concat(detail.map(d => [d.state, d.lga, d.facility, d.commodity, d.category, d.on_hand, d.backed, d.gap, d.lots_with_expiry, d.lots_with_batch, d.status].map(esc).join(',')))
    .join('\r\n')
  const out = resolve(process.cwd(), 'lot_coverage_report.csv')
  writeFileSync(out, csv, 'utf8')
  console.log(`\nFull (facility × commodity) breakdown written to:\n  ${out}`)
  console.log('Filter status = no-expiry / partial for the stock-take worklist.\n')
} catch (err) {
  console.error('Coverage report failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
