// Drive a bin's opening balance to 0 while leaving the REAL stock figure showing.
//
// opening = SOH - sum(recorded movements). Two levers, and the script applies them
// in this order:
//
//   1. --soh N   Set the bin to the true physical count (what is on the shelf).
//                Optional: omit it to keep whatever the bin already holds.
//   2. baseline  Post ONE dated, record-only 'Opening balance' adjustment equal to
//                the remaining gap, so the movements finally sum to SOH.
//
// Step 2 is RECORD-ONLY on purpose: the stock is already on the shelf, so crediting
// it again would double it. It writes to stock_adjustment_log and nothing else.
//
// Why a stock count cannot do this instead: a count moves BOTH sides of the
// subtraction by the same amount (it raises SOH and adds a matching correction), so
// the gap survives. Only a record that explains the pre-existing quantity closes it.
//
// HONESTY WARNING — read before using on a bin like Apapa General.
// This makes the bin card internally consistent, but it ATTRIBUTES the whole gap to
// an opening baseline. That is the truthful story when stock genuinely pre-dated the
// records (go-live/training seeding). It is NOT the truthful story when the gap came
// from duplicate 'Physical count correction' rows deducting one shelf several times —
// there the honest fix is to reverse those specific rows (--reverse below), which
// also happens to zero the opening. Run diagnose_phantom_openings.mjs first and
// decide per bin. Baselining a duplicate-deduction bin buries the evidence.
//
//   node scripts/fix_opening_balance.mjs "Apapa General"                      # dry run, list
//   node scripts/fix_opening_balance.mjs "Apapa General" "TDF/3TC/DTG"        # one commodity
//   node scripts/fix_opening_balance.mjs "Apapa General" "TDF/3TC/DTG" --soh 250
//   node scripts/fix_opening_balance.mjs "Apapa General" "TDF/3TC/DTG" --soh 250 --apply
//   node scripts/fix_opening_balance.mjs --reverse <adj-id>,<adj-id> --apply   # undo bogus rows
//
// Dry-run unless --apply. Every change is one transaction per bin.

import { pool, query, withTransaction } from '../src/db.js'
import { LotService } from '../src/services/lotService.js'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const sohArg = flag('--soh') != null ? parseInt(flag('--soh')) : null
const reverseIds = (flag('--reverse') || '').split(',').map(s => s.trim()).filter(Boolean)
const pos = argv.filter((a, i) => !a.startsWith('--') && !['--soh', '--reverse'].includes(argv[i - 1]))
const [facArg, commArg] = pos

const OUT = `('in_transit','dispatched','accepted')`
const BASELINE_REASON = 'Opening balance'

try {
  // ---- Mode B: reverse specific bogus adjustment rows -----------------------
  // For bins whose gap came from duplicate deductions. Deletes the named rows and
  // rebuilds nothing else — the stock figure is untouched, so removing a phantom
  // deduction raises the movement sum and the opening falls toward 0 on its own.
  if (reverseIds.length) {
    const rows = (await query(
      `select a.id, f.name facility, c.name commodity, a.adjustment_type, a.quantity, a.reason, a.adjusted_at, a.notes
         from stock_adjustment_log a
         join facilities f on f.id = a.facility_id
         join commodities c on c.id = a.commodity_id
        where a.id = any($1::uuid[])`, [reverseIds])).rows
    if (!rows.length) { console.log('No adjustment rows matched those ids.'); process.exit(1) }
    console.log(`\nAdjustment rows to DELETE (${rows.length}):\n`)
    console.table(rows.map(r => ({ facility: r.facility, commodity: r.commodity, date: r.adjusted_at?.toISOString?.().slice(0, 10),
      type: r.adjustment_type, qty: r.quantity, reason: r.reason })))
    console.log('\nStock on hand is NOT changed — only the erroneous records are removed.')
    if (!apply) { console.log('\nDRY RUN — re-run with --apply to delete them.'); process.exit(0) }
    await withTransaction(async exec => { await exec(`delete from stock_adjustment_log where id = any($1::uuid[])`, [reverseIds]) })
    console.log(`\n✓ Deleted ${rows.length} adjustment row(s). Re-run the audit to confirm the opening.`)
    process.exit(0)
  }

  // ---- Mode A: baseline the remaining gap ----------------------------------
  if (!facArg) { console.error('Usage: node scripts/fix_opening_balance.mjs "<facility>" ["<commodity>"] [--soh N] [--apply]'); process.exit(1) }
  const fac = (await query(`select id, name from facilities where name ilike $1`, [`%${facArg}%`])).rows
  if (fac.length !== 1) { console.log('Facility not unique:', fac.map(f => f.name)); process.exit(1) }
  const F = fac[0].id

  const params = [F]
  let commFilter = ''
  if (commArg) {
    const c = (await query(`select id, name from commodities where name ilike $1`, [`%${commArg}%`])).rows
    if (c.length !== 1) { console.log('Commodity not unique:', c.map(x => x.name)); process.exit(1) }
    commFilter = ` and s.commodity_id = $2`; params.push(c[0].id)
  }
  if (sohArg != null && !commArg) { console.error('--soh needs a single commodity (it sets one bin).'); process.exit(1) }
  if (sohArg != null && (!Number.isFinite(sohArg) || sohArg < 0)) { console.error('--soh must be 0 or more'); process.exit(1) }

  const bins = (await query(`
    with intake as (select facility_id f, commodity_id c, sum(quantity)::int q from intake_log where facility_id=$1 group by 1,2),
    adj as (select facility_id f, commodity_id c, sum(case when adjustment_type='Decrease' then -quantity else quantity end)::int q from stock_adjustment_log where facility_id=$1 group by 1,2),
    tin as (select receiving_facility_id f, commodity_id c, sum(quantity)::int q from stock_transfer_log where receiving_facility_id=$1 and status='accepted' and sending_facility_id is distinct from $1 group by 1,2),
    tout as (select sending_facility_id f, commodity_id c, sum(quantity)::int q from stock_transfer_log where sending_facility_id=$1 and status in ${OUT} group by 1,2)
    select s.commodity_id, cm.name commodity, s.quantity soh,
           (coalesce(i.q,0)+coalesce(a.q,0)+coalesce(ti.q,0)-coalesce(t2.q,0)) movements
      from stock s
      join commodities cm on cm.id = s.commodity_id
      left join intake i on i.f=s.facility_id and i.c=s.commodity_id
      left join adj a on a.f=s.facility_id and a.c=s.commodity_id
      left join tin ti on ti.f=s.facility_id and ti.c=s.commodity_id
      left join tout t2 on t2.f=s.facility_id and t2.c=s.commodity_id
     where s.facility_id=$1 and s.location_type='store' ${commFilter}`, params)).rows
    .map(r => {
      const targetSoh = sohArg != null ? sohArg : r.soh
      return { ...r, targetSoh, opening: targetSoh - r.movements }
    })
    .filter(r => r.opening !== 0 || r.targetSoh !== r.soh)
    .sort((a, b) => Math.abs(b.opening) - Math.abs(a.opening))

  console.log(`\n${fac[0].name} — store bins to correct (${bins.length})\n`)
  if (!bins.length) { console.log('Nothing to do: openings already 0.'); process.exit(0) }
  console.table(bins.map(b => ({
    commodity: b.commodity, current_SOH: b.soh,
    '→ SOH': b.targetSoh, movements: b.movements,
    opening_now: b.soh - b.movements, 'baseline to post': b.opening, opening_after: 0,
  })))
  console.log(`\nPosts a record-only '${BASELINE_REASON}' adjustment (stock NOT credited again),`)
  console.log('dated one day before the bin\'s earliest record so it reads as the opening line.')
  if (!apply) { console.log('\nDRY RUN — re-run with --apply.'); process.exit(0) }

  let n = 0
  for (const b of bins) {
    await withTransaction(async exec => {
      // 1. Set the true physical figure, if one was given.
      if (sohArg != null && b.targetSoh !== b.soh) {
        await exec(`update stock set quantity=$3, updated_at=now()
                     where facility_id=$1 and commodity_id=$2 and location_type='store'`, [F, b.commodity_id, b.targetSoh])
        await LotService.reconcile(exec, { facility_id: F, commodity_id: b.commodity_id, location_type: 'store', site_name: null })
      }
      // 2. Close the gap with one explicit baseline record. Record-only.
      if (b.opening !== 0) {
        const earliest = (await exec(
          `select least(
             coalesce((select min(received_at) from intake_log where facility_id=$1 and commodity_id=$2), now()),
             coalesce((select min(adjusted_at) from stock_adjustment_log where facility_id=$1 and commodity_id=$2), now())
           ) - interval '1 day' d`, [F, b.commodity_id])).rows[0].d
        await exec(
          `insert into stock_adjustment_log
             (facility_id, commodity_id, quantity, adjustment_type, reason, adjusted_by, reference_number, notes, adjusted_at)
           values ($1,$2,$3,$4,$5,'system','',$6,$7)`,
          [F, b.commodity_id, Math.abs(b.opening), b.opening > 0 ? 'Increase' : 'Decrease', BASELINE_REASON,
           `Baseline recorded to explain stock present before the records begin (opening was ${b.opening}). Stock not re-credited.`,
           earliest])
      }
    })
    n++
  }
  console.log(`\n✓ Corrected ${n} bin(s). Re-run audit_opening_balances.mjs to confirm they now read 0.`)
} catch (err) {
  console.error('Fix failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
