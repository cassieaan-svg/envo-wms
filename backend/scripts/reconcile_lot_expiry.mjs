// One-off reconcile for lot-ledger expiries that don't match the (corrected) log
// records. Two independent passes, both DRY-RUN unless --apply is given:
//
//  PASS 1 — relabel mismatched BATCHED lots. A batch has exactly one true expiry;
//    its authoritative value comes from the current credit records (intakes +
//    Increase adjustments). A ledger lot carrying that batch but a different expiry
//    is stale and is relabelled to match. Batches whose records disagree (more than
//    one expiry) are AMBIGUOUS — reported, never auto-fixed.
//
//  PASS 2 — backfill UNKNOWN-expiry stock. The migration seeded historical stock
//    into null-expiry "unknown" lots that carry no batch/expiry, so editing such a
//    record's expiry (before or after the app fix) had nothing to relabel. This pass
//    reconstructs the batch/expiry composition of a store bin's unknown stock from
//    its credit records: for each (batch, expiry) the records call for that the
//    ledger doesn't already hold, it relabels that many unknown units — soonest
//    expiry first, clamped to the unknown stock actually on hand.
//
// Store bins only; quantities are never changed (units are moved between lots in the
// same bin). Idempotent — re-running finds nothing left to do.
//
//   cd C:\envo\app\backend
//   node scripts/reconcile_lot_expiry.mjs           # DRY RUN — report only, no writes
//   node scripts/reconcile_lot_expiry.mjs --apply   # actually apply both passes

import { pool, query, withTransaction } from '../src/db.js'
import { StockService } from '../src/services/stockService.js'
import { LotService } from '../src/services/lotService.js'

const APPLY = process.argv.includes('--apply')
const short = id => String(id).slice(0, 8)

// Move `want` units from a store bin's UNKNOWN-expiry lots onto (batch, expiry).
// Transactional; returns how many were actually moved (<= want, <= unknown on hand).
async function backfillOne(bin, batch, expiry, want) {
  return withTransaction(async exec => {
    const base = [bin.facility_id, bin.commodity_id]
    const { rows } = await exec(
      `select id, quantity from stock_lot
        where facility_id=$1 and commodity_id=$2 and location_type='store' and coalesce(site_name,'')=''
          and expiry_date is null and quantity > 0
        order by id`, base)
    let need = want, drawn = 0
    for (const r of rows) {
      if (need <= 0) break
      const take = Math.min(r.quantity, need)
      await exec('update stock_lot set quantity = quantity - $2, updated_at = now() where id = $1', [r.id, take])
      drawn += take; need -= take
    }
    if (drawn > 0) {
      await exec(`delete from stock_lot where facility_id=$1 and commodity_id=$2 and location_type='store'
                    and coalesce(site_name,'')='' and quantity <= 0`, base)
      await LotService.credit(exec, { ...bin, location_type: 'store', site_name: null },
        { batch: batch || null, expiry, qty: drawn })
    }
    return drawn
  })
}

try {
  // Authoritative expiry per (facility, commodity, batch) from current credit rows.
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

  const { rows: fixable } = await query(`
    ${authCTE}
    select l.id lot_id, l.facility_id, l.commodity_id,
           l.location_type, coalesce(l.site_name,'') site,
           l.batch_number, l.quantity,
           to_char(l.expiry_date, 'YYYY-MM-DD') led_exp, a.auth_exp
      from stock_lot l
      join auth a on a.facility_id = l.facility_id and a.commodity_id = l.commodity_id
                 and a.batch = nullif(btrim(coalesce(l.batch_number,'')),'')
     where l.quantity > 0 and a.ndistinct = 1
       and coalesce(to_char(l.expiry_date,'YYYY-MM-DD'),'') <> coalesce(a.auth_exp,'')
     order by l.facility_id, l.commodity_id, l.batch_number`)

  const { rows: ambiguous } = await query(`
    ${authCTE}
    select distinct l.facility_id, l.commodity_id, l.batch_number,
           to_char(l.expiry_date,'YYYY-MM-DD') led_exp
      from stock_lot l
      join auth a on a.facility_id = l.facility_id and a.commodity_id = l.commodity_id
                 and a.batch = nullif(btrim(coalesce(l.batch_number,'')),'')
     where l.quantity > 0 and a.ndistinct > 1
     order by l.facility_id, l.commodity_id, l.batch_number`)

  // ── PASS 2 inputs: unknown store stock, target composition, what the ledger holds
  const key = (f, c) => `${f}|${c}`
  const { rows: unkBins } = await query(`
    select facility_id, commodity_id, sum(quantity) unk
      from stock_lot
     where location_type='store' and coalesce(site_name,'')='' and expiry_date is null and quantity > 0
     group by 1, 2`)
  const { rows: targets } = await query(`
    select facility_id, commodity_id, nullif(btrim(coalesce(batch_number,'')),'') batch,
           to_char(expiry_date,'YYYY-MM-DD') exp, sum(quantity) qty
      from (
        select facility_id, commodity_id, batch_number, expiry_date, quantity
          from intake_log where expiry_date is not null
        union all
        select facility_id, commodity_id, batch_number, expiry_date, quantity
          from stock_adjustment_log where adjustment_type='Increase' and expiry_date is not null
      ) c
     group by 1, 2, 3, 4`)
  const { rows: ledgerId } = await query(`
    select facility_id, commodity_id, coalesce(nullif(btrim(coalesce(batch_number,'')),''),'') batch,
           to_char(expiry_date,'YYYY-MM-DD') exp, sum(quantity) qty
      from stock_lot
     where location_type='store' and coalesce(site_name,'')='' and expiry_date is not null
     group by 1, 2, 3, 4`)

  const unkByBin = new Map(unkBins.map(b => [key(b.facility_id, b.commodity_id), Number(b.unk)]))
  const ledgerHave = new Map(ledgerId.map(r => [`${key(r.facility_id, r.commodity_id)}|${r.batch}|${r.exp}`, Number(r.qty)]))
  const targetsByBin = new Map()
  for (const t of targets) {
    const k = key(t.facility_id, t.commodity_id)
    if (!unkByBin.has(k)) continue                    // only bins that have unknown stock to place
    if (!targetsByBin.has(k)) targetsByBin.set(k, [])
    targetsByBin.get(k).push({ ...t, qty: Number(t.qty) })
  }

  const backfills = []
  for (const [k, list] of targetsByBin) {
    let unk = unkByBin.get(k)
    for (const t of list.sort((a, b) => (a.exp < b.exp ? -1 : a.exp > b.exp ? 1 : 0))) {
      if (unk <= 0) break
      const have = ledgerHave.get(`${k}|${t.batch || ''}|${t.exp}`) || 0
      const shortfall = t.qty - have
      if (shortfall <= 0) continue
      const move = Math.min(shortfall, unk)
      if (move <= 0) continue
      const [facility_id, commodity_id] = k.split('|')
      backfills.push({ facility_id, commodity_id, batch: t.batch, exp: t.exp, move })
      unk -= move
    }
  }

  // ── Report + apply
  console.log(`\n══════════ LOT EXPIRY RECONCILE ${APPLY ? '(APPLY)' : '(DRY RUN)'} ══════════\n`)

  console.log(`── Pass 1: relabel mismatched batched lots ──`)
  if (fixable.length === 0) {
    console.log('  ✓ none\n')
  } else {
    console.table(fixable.map(r => ({
      facility: short(r.facility_id), commodity: short(r.commodity_id),
      location: r.location_type + (r.site ? `:${r.site}` : ''),
      batch: r.batch_number, qty: Number(r.quantity),
      ledger_expiry: r.led_exp || '(none)', '→ corrected_to': r.auth_exp,
    })))
    if (APPLY) {
      let fixed = 0, failed = 0
      for (const r of fixable) {
        try { await StockService.relabelLot(r.lot_id, { batch_number: r.batch_number, expiry_date: r.auth_exp }); fixed++ }
        catch (e) { failed++; console.error(`  ✗ lot ${short(r.lot_id)} (${r.batch_number}): ${e.message}`) }
      }
      console.log(`  ✓ relabelled ${fixed}${failed ? `, ${failed} failed` : ''}\n`)
    }
  }

  console.log(`── Pass 2: backfill unknown-expiry store stock from records ──`)
  if (backfills.length === 0) {
    console.log('  ✓ none\n')
  } else {
    console.table(backfills.map(b => ({
      facility: short(b.facility_id), commodity: short(b.commodity_id),
      batch: b.batch || '(none)', '→ expiry': b.exp, units_from_unknown: b.move,
    })))
    if (APPLY) {
      let done = 0, moved = 0, failed = 0
      for (const b of backfills) {
        try {
          const m = await backfillOne({ facility_id: b.facility_id, commodity_id: b.commodity_id }, b.batch, b.exp, b.move)
          done++; moved += m
        } catch (e) { failed++; console.error(`  ✗ ${short(b.facility_id)}/${short(b.commodity_id)} → ${b.exp}: ${e.message}`) }
      }
      console.log(`  ✓ backfilled ${moved} unit(s) across ${done} identity(ies)${failed ? `, ${failed} failed` : ''}\n`)
    }
  }

  if (!APPLY && (fixable.length || backfills.length)) {
    console.log('DRY RUN — no changes written. Re-run with --apply to apply both passes.\n')
  }

  if (ambiguous.length > 0) {
    console.log(`⚠ ${ambiguous.length} batch(es) skipped (Pass 1) — logs carry more than one expiry for`)
    console.log('  the same batch; resolve by hand:\n')
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
