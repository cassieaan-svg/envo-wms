// One-off reconcile: fix lot-ledger expiries that went stale on intake/adjustment
// edits made BEFORE the "propagate edit to the lot ledger" fix. Back then, editing
// a record's batch/expiry updated the log row but not stock_lot, so the Monitoring
// expiry view kept flagging the OLD date.
//
// A batch number has exactly ONE true expiry. The authoritative expiry for a
// (facility, commodity, batch) comes from its current credit records — intakes and
// Increase adjustments (post-edit). Where a ledger lot for that batch shows a
// different expiry, the ledger is stale and is relabelled to match the record.
// Quantities are never changed (relabelLot merges into an existing identical lot).
//
// Batches whose credit records disagree with each other (more than one expiry in
// the logs) are AMBIGUOUS — reported, never auto-fixed. Unbatched lots can't be
// matched and are left alone. Safe to re-run: once fixed there's nothing to do.
//
//   cd C:\envo\app\backend
//   node scripts/reconcile_lot_expiry.mjs           # DRY RUN — report only, no writes
//   node scripts/reconcile_lot_expiry.mjs --apply   # actually relabel the stale lots

import { pool, query } from '../src/db.js'
import { StockService } from '../src/services/stockService.js'

const APPLY = process.argv.includes('--apply')
const short = id => String(id).slice(0, 8)

try {
  // Authoritative expiry per (facility, commodity, batch), from current credit rows.
  // ndistinct = how many different non-null expiries the logs carry for that batch:
  //   1  -> unambiguous, `auth_exp` is the truth
  //  >1  -> ambiguous, leave for a human
  const authCTE = `
    with credits as (
      select facility_id, commodity_id,
             nullif(btrim(coalesce(batch_number,'')),'') batch,
             to_char(expiry_date, 'YYYY-MM-DD') exp
        from intake_log
      union all
      select facility_id, commodity_id,
             nullif(btrim(coalesce(batch_number,'')),'') batch,
             to_char(expiry_date, 'YYYY-MM-DD') exp
        from stock_adjustment_log
       where adjustment_type = 'Increase'
    ),
    auth as (
      select facility_id, commodity_id, batch,
             count(distinct exp) filter (where exp is not null) ndistinct,
             max(exp)            filter (where exp is not null) auth_exp
        from credits
       where batch is not null
       group by 1, 2, 3
    )`

  // Ledger lots whose batch has a single authoritative expiry that differs from
  // what the ledger holds -> the fixable candidates.
  const { rows: fixable } = await query(`
    ${authCTE}
    select l.id lot_id, l.facility_id, l.commodity_id,
           l.location_type, coalesce(l.site_name,'') site,
           l.batch_number, l.quantity,
           to_char(l.expiry_date, 'YYYY-MM-DD') led_exp,
           a.auth_exp
      from stock_lot l
      join auth a
        on a.facility_id = l.facility_id
       and a.commodity_id = l.commodity_id
       and a.batch = nullif(btrim(coalesce(l.batch_number,'')),'')
     where l.quantity > 0
       and a.ndistinct = 1
       and coalesce(to_char(l.expiry_date,'YYYY-MM-DD'),'') <> coalesce(a.auth_exp,'')
     order by l.facility_id, l.commodity_id, l.batch_number`)

  // Ambiguous batches that ALSO have a mismatching ledger lot — surfaced for review.
  const { rows: ambiguous } = await query(`
    ${authCTE}
    select distinct l.facility_id, l.commodity_id, l.batch_number,
           to_char(l.expiry_date,'YYYY-MM-DD') led_exp
      from stock_lot l
      join auth a
        on a.facility_id = l.facility_id
       and a.commodity_id = l.commodity_id
       and a.batch = nullif(btrim(coalesce(l.batch_number,'')),'')
     where l.quantity > 0
       and a.ndistinct > 1
     order by l.facility_id, l.commodity_id, l.batch_number`)

  console.log(`\n══════════ LOT EXPIRY RECONCILE ${APPLY ? '(APPLY)' : '(DRY RUN)'} ══════════\n`)

  if (fixable.length === 0) {
    console.log('✓ No stale ledger expiries found — nothing to fix.\n')
  } else {
    console.log(`${fixable.length} ledger lot(s) with an expiry that disagrees with the corrected record:\n`)
    console.table(fixable.map(r => ({
      facility: short(r.facility_id), commodity: short(r.commodity_id),
      location: r.location_type + (r.site ? `:${r.site}` : ''),
      batch: r.batch_number, qty: Number(r.quantity),
      ledger_expiry: r.led_exp || '(none)', '→ corrected_to': r.auth_exp,
    })))

    if (!APPLY) {
      console.log('\nDRY RUN — no changes written. Re-run with --apply to relabel these lots.\n')
    } else {
      let fixed = 0, failed = 0
      for (const r of fixable) {
        try {
          await StockService.relabelLot(r.lot_id, { batch_number: r.batch_number, expiry_date: r.auth_exp })
          fixed++
        } catch (e) {
          failed++
          console.error(`  ✗ lot ${short(r.lot_id)} (${r.batch_number}): ${e.message}`)
        }
      }
      console.log(`\n✓ Relabelled ${fixed} lot(s)${failed ? `, ${failed} failed` : ''}.\n`)
    }
  }

  if (ambiguous.length > 0) {
    console.log(`⚠ ${ambiguous.length} batch(es) skipped — the logs carry MORE THAN ONE expiry for the`)
    console.log('  same batch, so the correct value is unclear. Review these by hand:\n')
    console.table(ambiguous.map(r => ({
      facility: short(r.facility_id), commodity: short(r.commodity_id),
      batch: r.batch_number, ledger_expiry: r.led_exp || '(none)',
    })))
  }
} catch (err) {
  console.error('Reconcile failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
