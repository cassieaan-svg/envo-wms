// Reconcile a facility's STORE stock to what its records say — for seed mismatches
// where intakes/transfers were loaded but the stock figure was set independently
// (so the bin card shows a non-zero opening balance). Sets store SOH = the record
// net (intakes + Increase adj − Decrease adj + transfers in[accepted] − transfers
// out[dispatched] − store→site redistributions[dispatched]) and reconciles the
// store lot ledger to match. That makes the opening balance 0.
//
// Step 1 — see the mismatches (read-only):
//   node scripts/fix_store_stock.mjs "Ikpe Annang"
//   node scripts/fix_store_stock.mjs "Ikpe Annang" "Cotrimoxazole 960mg"
//
// Step 2 — apply (set SOH to the record for every mismatched commodity shown):
//   node scripts/fix_store_stock.mjs "Ikpe Annang" --apply
//
// Only touches commodities whose store SOH != record net. Use the commodity arg to
// scope to one. Dry-run unless --apply.

import { pool, query, withTransaction } from '../src/db.js'
import { LogService } from '../src/services/logService.js'
import { LotService } from '../src/services/lotService.js'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const pos = argv.filter(a => a !== '--apply')
const [facArg, commArg] = pos
if (!facArg) { console.error('Usage: node scripts/fix_store_stock.mjs "<facility>" ["<commodity>"] [--apply]'); process.exit(1) }
const OUT = `('in_transit','dispatched','accepted')`   // store OUT counts once dispatched

try {
  const fac = (await query(`select id, name from facilities where name ilike $1`, [`%${facArg}%`])).rows
  if (fac.length !== 1) { console.log('Facility not unique:', fac.map(f => f.name)); process.exit(1) }
  const F = fac[0].id
  let commFilter = '', params = [F]
  if (commArg) {
    const c = (await query(`select id, name from commodities where name ilike $1`, [`%${commArg}%`])).rows
    if (c.length !== 1) { console.log('Commodity not unique:', c.map(x => x.name)); process.exit(1) }
    commFilter = ' and c.id = $2'; params.push(c[0].id)
  }

  // Record net for the store, per commodity, vs the actual store SOH.
  const rows = (await query(`
    with comm as (select id from commodities c where true ${commArg ? 'and c.id=$2' : ''}),
    intake as (select commodity_id, sum(quantity)::int q from intake_log where facility_id=$1 group by 1),
    adj as (select commodity_id, sum(case when adjustment_type='Decrease' then -quantity else quantity end)::int q from stock_adjustment_log where facility_id=$1 group by 1),
    tin as (select commodity_id, sum(quantity)::int q from stock_transfer_log where receiving_facility_id=$1 and sending_facility_id is distinct from $1 and status='accepted' group by 1),
    tout as (select commodity_id, sum(quantity)::int q from stock_transfer_log where sending_facility_id=$1 and status in ${OUT} group by 1),
    soh as (select commodity_id, quantity from stock where facility_id=$1 and location_type='store')
    select cm.id commodity_id, cmn.name commodity,
           coalesce(soh.quantity,0) soh,
           (coalesce(intake.q,0)+coalesce(adj.q,0)+coalesce(tin.q,0)-coalesce(tout.q,0)) record_net
      from comm cm
      join commodities cmn on cmn.id = cm.id
      left join intake on intake.commodity_id=cm.id
      left join adj on adj.commodity_id=cm.id
      left join tin on tin.commodity_id=cm.id
      left join tout on tout.commodity_id=cm.id
      left join soh on soh.commodity_id=cm.id
     where coalesce(soh.quantity,0) <> (coalesce(intake.q,0)+coalesce(adj.q,0)+coalesce(tin.q,0)-coalesce(tout.q,0))
     order by abs(coalesce(soh.quantity,0)-(coalesce(intake.q,0)+coalesce(adj.q,0)+coalesce(tin.q,0)-coalesce(tout.q,0))) desc`,
    params)).rows.filter(r => r.record_net >= 0)   // never set a store negative

  console.log(`\n${fac[0].name} — store SOH vs record net (${rows.length} mismatched commodity/ies)\n`)
  console.table(rows.map(r => ({ commodity: r.commodity, current_SOH: r.soh, '→ set to record': r.record_net, delta: r.record_net - r.soh })))
  if (rows.length === 0) { console.log('Nothing to reconcile.'); process.exit(0) }
  if (!apply) { console.log('\nDRY RUN — re-run with --apply to set each store SOH to its record net.'); process.exit(0) }

  let n = 0
  for (const r of rows) {
    await withTransaction(async exec => {
      await exec(`insert into stock (facility_id, commodity_id, location_type, quantity) values ($1,$2,'store',$3)
                  on conflict (facility_id, commodity_id, location_type) do update set quantity=$3, updated_at=now()`, [F, r.commodity_id, r.record_net])
      // Rebuild the store ledger straight from the records so lots carry the intake's
      // real batch/expiry (falls back to a plain reconcile if it can't tie out).
      const key = { facility_id: F, commodity_id: r.commodity_id }
      const rebuilt = await LogService._rebuildStoreFromRecords(exec, key)
      if (!rebuilt) await LotService.reconcile(exec, { ...key, location_type: 'store', site_name: null })
    })
    n++
  }
  console.log(`\n✓ Reconciled ${n} store bin(s) to their record net.`)
} catch (err) {
  console.error('Fix failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
