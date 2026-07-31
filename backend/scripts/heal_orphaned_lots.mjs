// One-off repair for lot-ledger lots left ORPHANED by a batch rename made before the
// edit-sync fix. When an intake's batch/expiry was corrected under the old code, the
// ledger kept the ORIGINAL batch — in the store AND any site the stock had moved to
// (dispensary/DSD/SDP) — so "stock by batch" still shows the stale/expired batch.
// Those orphans can't be matched by batch (no record references them anymore), so the
// expiry reconcile can't touch them.
//
// This heals every (facility, commodity) whose records credit exactly ONE batch/expiry
// — the common case — by relabelling every on-hand lot in every bin onto that identity
// (quantities per bin preserved). Pairs whose records carry MORE THAN ONE identity are
// reported for manual review, never auto-changed. Idempotent; safe to re-run.
//
//   cd C:\envo\app\backend
//   node scripts/heal_orphaned_lots.mjs           # DRY RUN — report only
//   node scripts/heal_orphaned_lots.mjs --apply   # relabel the orphaned lots

import { pool, query, withTransaction } from '../src/db.js'
import { LogService } from '../src/services/logService.js'

const APPLY = process.argv.includes('--apply')
const short = id => String(id).slice(0, 8)

// Net-positive record identities per (facility, commodity).
const RECS_CTE = `
  with recs as (
    select facility_id, commodity_id,
           coalesce(nullif(btrim(coalesce(batch_number,'')),''),'') batch,
           to_char(expiry_date,'YYYY-MM-DD') exp, sum(q)::int qty
      from (
        select facility_id, commodity_id, batch_number, expiry_date, quantity q from intake_log
        union all
        select facility_id, commodity_id, batch_number, expiry_date, quantity from stock_adjustment_log where adjustment_type='Increase'
        union all
        select facility_id, commodity_id, batch_number, expiry_date, -quantity from stock_adjustment_log where adjustment_type='Decrease'
      ) c group by 1,2,3,4 having sum(q) > 0
  ),
  ident as (   -- how many distinct identities each pair's records credit
    select facility_id, commodity_id, count(*) n, max(batch) batch, max(exp) exp
      from recs group by 1,2
  )`

try {
  // Single-identity pairs whose ledger holds a lot that ISN'T that identity → fixable.
  const { rows: fixable } = await query(`
    ${RECS_CTE}
    select i.facility_id, i.commodity_id, i.batch, i.exp,
           (select coalesce(sum(l.quantity),0) from stock_lot l
             where l.facility_id=i.facility_id and l.commodity_id=i.commodity_id and l.quantity>0
               and (coalesce(nullif(btrim(coalesce(l.batch_number,'')),''),'') <> i.batch
                    or coalesce(to_char(l.expiry_date,'YYYY-MM-DD'),'') <> coalesce(i.exp,''))) mismatched_qty
      from ident i
     where i.n = 1
     order by mismatched_qty desc`)
  const toFix = fixable.filter(r => Number(r.mismatched_qty) > 0)

  // Multi-identity pairs that ALSO have an orphaned ledger batch (a batch in no record) — manual.
  const { rows: ambiguous } = await query(`
    ${RECS_CTE}
    select distinct l.facility_id, l.commodity_id, l.batch_number,
           to_char(l.expiry_date,'YYYY-MM-DD') led_exp, l.quantity
      from stock_lot l
      join ident i on i.facility_id=l.facility_id and i.commodity_id=l.commodity_id and i.n > 1
     where l.quantity > 0
       and not exists (select 1 from recs r
                        where r.facility_id=l.facility_id and r.commodity_id=l.commodity_id
                          and r.batch = coalesce(nullif(btrim(coalesce(l.batch_number,'')),''),'')
                          and coalesce(r.exp,'') = coalesce(to_char(l.expiry_date,'YYYY-MM-DD'),''))
     order by l.quantity desc`)

  console.log(`\n══════════ HEAL ORPHANED LOTS ${APPLY ? '(APPLY)' : '(DRY RUN)'} ══════════\n`)

  console.log(`── Single-identity pairs with mismatched ledger lots ──`)
  if (toFix.length === 0) {
    console.log('  ✓ none\n')
  } else {
    console.table(toFix.map(r => ({
      facility: short(r.facility_id), commodity: short(r.commodity_id),
      '→ batch': r.batch || '(none)', '→ expiry': r.exp || '(none)', units_relabelled: Number(r.mismatched_qty),
    })))
    if (APPLY) {
      let ok = 0, failed = 0
      for (const r of toFix) {
        try { await withTransaction(exec => LogService._healOrphanedBins(exec, { facility_id: r.facility_id, commodity_id: r.commodity_id })); ok++ }
        catch (e) { failed++; console.error(`  ✗ ${short(r.facility_id)}/${short(r.commodity_id)}: ${e.message}`) }
      }
      console.log(`  ✓ healed ${ok} pair(s)${failed ? `, ${failed} failed` : ''}\n`)
    } else {
      console.log('\n  DRY RUN — re-run with --apply to relabel.\n')
    }
  }

  if (ambiguous.length > 0) {
    console.log(`⚠ ${ambiguous.length} orphaned ledger lot(s) under MULTI-batch commodities — review by hand:\n`)
    console.table(ambiguous.map(r => ({
      facility: short(r.facility_id), commodity: short(r.commodity_id),
      orphan_batch: r.batch_number || '(none)', expiry: r.led_exp || '(none)', qty: r.quantity,
    })))
  }
} catch (err) {
  console.error('Heal failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
