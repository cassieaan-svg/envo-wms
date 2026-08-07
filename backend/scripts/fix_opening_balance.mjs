// Drive a bin's opening balance to 0 while leaving the REAL stock figure showing.
// Works on ANY bin: store, dispensary, DSD site, SDP site.
//
// opening = SOH − Σ(recorded movements). Two levers, applied in this order:
//
//   1. --soh N   Set the bin to the true physical count (what is on the shelf).
//                Optional: omit to keep whatever the bin already holds.
//   2. baseline  Record the remaining gap in bin_opening, so the movements finally
//                sum to SOH and the bin card opens with an attributable line item.
//
// The baseline is RECORD ONLY: the stock is already on the shelf, so crediting it
// again would double it. It writes one bin_opening row and nothing else.
//
// Why a physical count cannot do this instead: a count moves BOTH sides of the
// subtraction by the same amount (raises SOH, adds a matching correction), so the
// gap survives. Only a record explaining the pre-existing quantity closes it.
//
// HONESTY WARNING. This attributes the whole gap to an opening baseline — the
// truthful story when stock genuinely pre-dated the records (go-live/training
// seeding). It is NOT the truthful story when the gap came from duplicate
// 'Physical count correction' rows deducting one shelf repeatedly; there the honest
// remedy is --reverse on those specific rows, which also zeroes the opening.
// Run diagnose_bin_openings.mjs first and decide per bin.
//
//   node scripts/fix_opening_balance.mjs "Apapa General"                       # dry run, list store bins
//   node scripts/fix_opening_balance.mjs "Apapa General" "TDF/3TC/DTG" --soh 250
//   node scripts/fix_opening_balance.mjs "Apapa General" "TDF/3TC/DTG" --soh 250 --apply
//   node scripts/fix_opening_balance.mjs "Ikot Ebok" "Alere" --bin sdp --site "Main Lab" --soh 226 --apply
//   node scripts/fix_opening_balance.mjs "Ikot Ebok" "Alere" --bin dispensary --apply   # baseline only
//   node scripts/fix_opening_balance.mjs --reverse <adj-id>,<adj-id> --apply            # undo bogus rows
//
// Dry-run unless --apply. One transaction per bin.

import { pool, query, withTransaction } from '../src/db.js'
import { LotService } from '../src/services/lotService.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const sohArg = flag('--soh') != null ? parseInt(flag('--soh')) : null
const binArg = (flag('--bin') || 'store').toLowerCase()
const siteArg = flag('--site')
const by = flag('--by') || 'system'
const reverseIds = (flag('--reverse') || '').split(',').map(s => s.trim()).filter(Boolean)
const pos = argv.filter((a, i) => !a.startsWith('--') && !['--soh', '--reverse', '--bin', '--site', '--by'].includes(argv[i - 1]))
const [facArg, commArg] = pos

const OUT = `('in_transit','dispatched','accepted')`
const TAGQ = `case when notes ~* '\\[SDP:' then 'sdp:'||btrim(substring(notes from '\\[SDP:\\s*([^\\]]+)\\]'))
                   when notes ~* '\\[DSD:' then 'dsd:'||btrim(substring(notes from '\\[DSD:\\s*([^\\]]+)\\]'))
                   else 'dispensary' end`

try {
  // ---- Mode B: reverse specific bogus adjustment rows -----------------------
  // Stock on hand is untouched: removing a phantom deduction raises the movement
  // sum, so the opening falls toward 0 on its own with the evidence intact.
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
    // Write the FULL rows to an undo file BEFORE touching anything, so the delete is
    // reversible without restoring the whole database. Written first on purpose: if
    // this fails, nothing has been deleted yet.
    const full = (await query(`select * from stock_adjustment_log where id = any($1::uuid[])`, [reverseIds])).rows
    const undo = `undo_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    fs.writeFileSync(undo, JSON.stringify({ table: 'stock_adjustment_log', deleted_at: new Date().toISOString(), rows: full }, null, 2))
    console.log(`\nUndo file written: ${undo}`)
    console.log(`Restore with:  node scripts/restore_deleted.mjs ${undo}`)

    await withTransaction(async exec => { await exec(`delete from stock_adjustment_log where id = any($1::uuid[])`, [reverseIds]) })
    console.log(`\n✓ Deleted ${rows.length} adjustment row(s). Re-run the audit to confirm the opening.`)
    process.exit(0)
  }

  // ---- Mode A: baseline the remaining gap ----------------------------------
  if (!facArg) { console.error('Usage: node scripts/fix_opening_balance.mjs "<facility>" ["<commodity>"] [--bin store|dispensary|dsd|sdp] [--site "<name>"] [--soh N] [--apply]'); process.exit(1) }
  if (!['store', 'dispensary', 'dsd', 'sdp'].includes(binArg)) { console.error('--bin must be store, dispensary, dsd or sdp'); process.exit(1) }
  if ((binArg === 'dsd' || binArg === 'sdp') && !siteArg) { console.error('--site is required for a dsd/sdp bin'); process.exit(1) }
  if (sohArg != null && (!Number.isFinite(sohArg) || sohArg < 0)) { console.error('--soh must be 0 or more'); process.exit(1) }
  if (sohArg != null && !commArg) { console.error('--soh needs a single commodity (it sets one bin).'); process.exit(1) }

  const fac = (await query(`select id, name from facilities where name ilike $1`, [`%${facArg}%`])).rows
  if (fac.length !== 1) { console.log('Facility not unique:', fac.map(f => f.name)); process.exit(1) }
  const F = fac[0].id
  let commId = null
  if (commArg) {
    const c = (await query(`select id, name from commodities where name ilike $1`, [`%${commArg}%`])).rows
    if (c.length !== 1) { console.log('Commodity not unique:', c.map(x => x.name)); process.exit(1) }
    commId = c[0].id
  }
  const binKey = binArg === 'store' || binArg === 'dispensary' ? binArg : `${binArg}:${siteArg}`

  // Movements + SOH for the requested bin(s), mirroring the audit exactly.
  let bins
  if (binArg === 'store' || binArg === 'dispensary') {
    const p = [F], cf = commId ? ` and s.commodity_id = $2` : ''
    if (commId) p.push(commId)
    bins = (await query(`
      with intake as (select commodity_id c, sum(quantity)::int q from intake_log where facility_id=$1 group by 1),
      adj as (select commodity_id c, sum(case when adjustment_type='Decrease' then -quantity else quantity end)::int q from stock_adjustment_log where facility_id=$1 group by 1),
      tin as (select commodity_id c, sum(quantity)::int q from stock_transfer_log where receiving_facility_id=$1 and status='accepted' and sending_facility_id is distinct from $1 group by 1),
      tout as (select commodity_id c, sum(quantity)::int q from stock_transfer_log where sending_facility_id=$1 and status in ${OUT} group by 1),
      drecv as (select commodity_id c, sum(quantity)::int q from stock_transfer_log where sending_facility_id=$1 and status='accepted' and (receiving_facility_id is null or receiving_facility_id=$1) and (${TAGQ})='dispensary' group by 1),
      diss as (select commodity_id c, sum(quantity)::int q from dispense_log where facility_id=$1 and (${TAGQ})='dispensary' group by 1),
      dret as (select commodity_id c, sum(quantity)::int q from stock_adjustment_log where facility_id=$1 and reason='Returned from Dispensary' group by 1),
      op as (select commodity_id c, quantity q from bin_opening where facility_id=$1 and location_type=$${p.length + 1} and coalesce(site_name,'')='')
      select s.commodity_id, cm.name commodity, s.quantity soh,
             case when $${p.length + 1}='store'
                  then coalesce(i.q,0)+coalesce(a.q,0)+coalesce(ti.q,0)-coalesce(t2.q,0)
                  else coalesce(dr.q,0)-coalesce(di.q,0)-coalesce(dt.q,0) end + coalesce(op.q,0) movements
        from stock s
        join commodities cm on cm.id = s.commodity_id
        left join intake i on i.c=s.commodity_id  left join adj a on a.c=s.commodity_id
        left join tin ti on ti.c=s.commodity_id   left join tout t2 on t2.c=s.commodity_id
        left join drecv dr on dr.c=s.commodity_id left join diss di on di.c=s.commodity_id
        left join dret dt on dt.c=s.commodity_id  left join op on op.c=s.commodity_id
       where s.facility_id=$1 and s.location_type=$${p.length + 1} ${cf}`,
      [...p, binArg])).rows
  } else {
    const tbl = binArg === 'dsd' ? 'dsd_stock' : 'sdp_stock'
    const col = binArg === 'dsd' ? 'dsd_site_name' : 'sdp_name'
    const tag = `%[${binArg.toUpperCase()}: ${siteArg}]%`
    const p = [F, siteArg, tag], cf = commId ? ` and s.commodity_id = $4` : ''
    if (commId) p.push(commId)
    bins = (await query(`
      with recv as (select commodity_id c, sum(quantity)::int q from stock_transfer_log where sending_facility_id=$1 and status='accepted' and (receiving_facility_id is null or receiving_facility_id=$1) and notes ilike $3 group by 1),
      iss as (select commodity_id c, sum(quantity)::int q from dispense_log where facility_id=$1 and notes ilike $3 group by 1),
      ret as (select commodity_id c, sum(quantity)::int q from stock_adjustment_log where facility_id=$1 and reason in ('Returned from DSD','Returned from SDP') and notes ilike '%'||$2||'%' group by 1),
      op as (select commodity_id c, quantity q from bin_opening where facility_id=$1 and location_type='${binArg}' and lower(btrim(coalesce(site_name,'')))=lower(btrim($2)))
      select s.commodity_id, cm.name commodity, s.quantity soh,
             (coalesce(r.q,0)-coalesce(i.q,0)-coalesce(rt.q,0)+coalesce(op.q,0)) movements
        from ${tbl} s
        join commodities cm on cm.id = s.commodity_id
        left join recv r on r.c=s.commodity_id left join iss i on i.c=s.commodity_id
        left join ret rt on rt.c=s.commodity_id left join op on op.c=s.commodity_id
       where s.facility_id=$1 and lower(btrim(s.${col}))=lower(btrim($2)) ${cf}`, p)).rows
  }

  const work = bins.map(r => {
    const targetSoh = sohArg != null ? sohArg : r.soh
    return { ...r, targetSoh, opening: targetSoh - r.movements }
  }).filter(r => r.opening !== 0 || r.targetSoh !== r.soh)
    .sort((a, b) => Math.abs(b.opening) - Math.abs(a.opening))

  console.log(`\n${fac[0].name} — ${binKey} bins to correct (${work.length})\n`)
  if (!work.length) { console.log('Nothing to do: openings already 0.'); process.exit(0) }
  console.table(work.map(b => ({
    commodity: b.commodity, current_SOH: b.soh, '→ SOH': b.targetSoh, movements: b.movements,
    opening_now: b.soh - b.movements, 'baseline to record': b.opening, opening_after: 0,
  })))
  console.log(`\nRecords a bin_opening row (stock NOT credited again), dated one day before`)
  console.log(`the bin's earliest record so it reads as the opening line on the bin card.`)
  if (!apply) { console.log('\nDRY RUN — re-run with --apply.'); process.exit(0) }

  let n = 0
  for (const b of work) {
    await withTransaction(async exec => {
      // 1. Set the true physical figure, if one was given.
      if (sohArg != null && b.targetSoh !== b.soh) {
        if (binArg === 'store' || binArg === 'dispensary') {
          await exec(`insert into stock (facility_id, commodity_id, location_type, quantity) values ($1,$2,$3,$4)
                      on conflict (facility_id, commodity_id, location_type) do update set quantity=$4, updated_at=now()`,
            [F, b.commodity_id, binArg, b.targetSoh])
        } else {
          const tbl = binArg === 'dsd' ? 'dsd_stock' : 'sdp_stock'
          const col = binArg === 'dsd' ? 'dsd_site_name' : 'sdp_name'
          await exec(`insert into ${tbl} (facility_id, ${col}, commodity_id, quantity) values ($1,$2,$3,$4)
                      on conflict (facility_id, ${col}, commodity_id) do update set quantity=$4, updated_at=now()`,
            [F, siteArg, b.commodity_id, b.targetSoh])
        }
        await LotService.reconcile(exec, { facility_id: F, commodity_id: b.commodity_id, location_type: binArg, site_name: siteArg || null })
      }
      // 2. Close the gap with one explicit baseline record. One row per bin, so a
      //    re-baseline replaces rather than stacks.
      if (b.opening !== 0) {
        const earliest = (await exec(
          `select least(
             coalesce((select min(received_at) from intake_log where facility_id=$1 and commodity_id=$2), now()),
             coalesce((select min(adjusted_at) from stock_adjustment_log where facility_id=$1 and commodity_id=$2), now()),
             coalesce((select min(dispensed_at) from dispense_log where facility_id=$1 and commodity_id=$2), now()),
             coalesce((select min(coalesce(resolved_at,initiated_at)) from stock_transfer_log where sending_facility_id=$1 and commodity_id=$2), now())
           ) - interval '1 day' d`, [F, b.commodity_id])).rows[0].d
        await exec(
          `insert into bin_opening (facility_id, commodity_id, location_type, site_name, quantity, opened_at, recorded_by, notes)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (facility_id, commodity_id, location_type, coalesce(site_name,''))
           do update set quantity=$5, opened_at=$6, recorded_by=$7, notes=$8`,
          [F, b.commodity_id, binArg, siteArg || null, b.opening, earliest, by,
           `Balance on hand before the first recorded movement (opening was ${b.opening}). Stock not re-credited.`])
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
