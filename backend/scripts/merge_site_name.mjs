// Merge a mistyped DSD/SDP site name into the correct one at a facility. The same
// physical site typed two ways (e.g. "VINZORB Pharmacy" vs "Vinzorb Pharmacy", or
// "ITELEWA" vs "Ita Elewa PHC, Ikorodu") splits into two bins — one holds the stock,
// the other the dispenses — so both show offsetting opening balances. Merging the
// name collapses them to one, which reconciles.
//
// Moves the site stock (dsd_stock/sdp_stock) and lot ledger from → to (summing where
// they overlap) and retags dispense/transfer/return-adjustment notes ([DSD:/SDP: from]
// and "Returned from … : from") to the canonical name. Across ALL commodities.
//
//   node scripts/merge_site_name.mjs "Ituk Mbang" dsd "VINZORB Pharmacy" "Vinzorb Pharmacy"        # dry run
//   node scripts/merge_site_name.mjs "Ituk Mbang" dsd "VINZORB Pharmacy" "Vinzorb Pharmacy" --apply

import { pool, query, withTransaction } from '../src/db.js'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const [facArg, tagArg, fromName, toName] = argv.filter(a => a !== '--apply')
if (!facArg || !tagArg || !fromName || !toName) {
  console.error('Usage: node scripts/merge_site_name.mjs "<facility>" <dsd|sdp> "<from name>" "<to name>" [--apply]'); process.exit(1)
}
const tag = tagArg.toLowerCase()
if (!['dsd', 'sdp'].includes(tag)) { console.error('tag must be dsd or sdp'); process.exit(1) }
const stockTbl = tag === 'dsd' ? 'dsd_stock' : 'sdp_stock'
const siteCol = tag === 'dsd' ? 'dsd_site_name' : 'sdp_name'
const TAG = tag.toUpperCase()

try {
  const fac = (await query(`select id, name from facilities where name ilike $1`, [`%${facArg}%`])).rows
  if (fac.length !== 1) { console.log('Facility not unique:', fac.map(f => f.name)); process.exit(1) }
  const F = fac[0].id
  console.log(`\n${fac[0].name} — merge ${TAG} site  "${fromName}"  →  "${toName}"\n`)

  const cur = (await query(`select ${siteCol} site, count(*) rows, sum(quantity)::int qty from ${stockTbl}
                             where facility_id=$1 and ${siteCol} in ($2,$3) group by 1`, [F, fromName, toName])).rows
  const disp = (await query(`select count(*) n from dispense_log where facility_id=$1 and notes ilike $2`, [F, `%[${TAG}: ${fromName}]%`])).rows[0].n
  const xfer = (await query(`select count(*) n from stock_transfer_log where sending_facility_id=$1 and notes ilike $2`, [F, `%[${TAG}: ${fromName}]%`])).rows[0].n
  const ret  = (await query(`select count(*) n from stock_adjustment_log where facility_id=$1 and notes ilike $2`, [F, `%${fromName}%`])).rows[0].n
  console.log('current site stock rows:'); console.table(cur.length ? cur : [{ note: 'none' }])
  console.log(`notes to retag → dispenses: ${disp}, transfers: ${xfer}, return-adjustments referencing "${fromName}": ${ret}`)

  if (!apply) { console.log('\nDRY RUN — re-run with --apply to merge.'); process.exit(0) }

  await withTransaction(async exec => {
    // 1) site stock: add from→to where both exist, delete merged, rename the rest.
    await exec(`update ${stockTbl} t set quantity = t.quantity + f.quantity, updated_at=now()
                  from ${stockTbl} f where t.facility_id=$1 and t.${siteCol}=$3 and f.facility_id=$1 and f.${siteCol}=$2 and f.commodity_id=t.commodity_id`, [F, fromName, toName])
    await exec(`delete from ${stockTbl} f where f.facility_id=$1 and f.${siteCol}=$2 and exists (select 1 from ${stockTbl} t where t.facility_id=$1 and t.${siteCol}=$3 and t.commodity_id=f.commodity_id)`, [F, fromName, toName])
    await exec(`update ${stockTbl} set ${siteCol}=$3 where facility_id=$1 and ${siteCol}=$2`, [F, fromName, toName])

    // 2) lot ledger: same merge, keyed by (commodity, batch, expiry).
    await exec(`update stock_lot t set quantity = t.quantity + f.quantity, updated_at=now()
                  from stock_lot f
                 where t.facility_id=$1 and t.location_type=$4 and coalesce(t.site_name,'')=$3
                   and f.facility_id=$1 and f.location_type=$4 and coalesce(f.site_name,'')=$2
                   and f.commodity_id=t.commodity_id and coalesce(f.batch_number,'')=coalesce(t.batch_number,'')
                   and coalesce(f.expiry_date,'0001-01-01'::date)=coalesce(t.expiry_date,'0001-01-01'::date)`, [F, fromName, toName, tag])
    await exec(`delete from stock_lot f where f.facility_id=$1 and f.location_type=$4 and coalesce(f.site_name,'')=$2
                 and exists (select 1 from stock_lot t where t.facility_id=$1 and t.location_type=$4 and coalesce(t.site_name,'')=$3
                   and t.commodity_id=f.commodity_id and coalesce(t.batch_number,'')=coalesce(f.batch_number,'')
                   and coalesce(t.expiry_date,'0001-01-01'::date)=coalesce(f.expiry_date,'0001-01-01'::date))`, [F, fromName, toName, tag])
    await exec(`update stock_lot set site_name=$3 where facility_id=$1 and location_type=$4 and coalesce(site_name,'')=$2`, [F, fromName, toName, tag])

    // 3) retag notes: [TAG: from] → [TAG: to] on dispenses & transfers, and the site
    //    name inside "Returned from … : from" adjustments.
    await exec(`update dispense_log set notes = replace(notes, $2, $3) where facility_id=$1 and notes like '%'||$2||'%'`, [F, `[${TAG}: ${fromName}]`, `[${TAG}: ${toName}]`])
    await exec(`update stock_transfer_log set notes = replace(notes, $2, $3) where sending_facility_id=$1 and notes like '%'||$2||'%'`, [F, `[${TAG}: ${fromName}]`, `[${TAG}: ${toName}]`])
    await exec(`update stock_adjustment_log set notes = replace(notes, $2, $3)
                 where facility_id=$1 and reason in ('Returned from DSD','Returned from SDP') and notes like '%: '||$2||'%'`, [F, fromName, toName])
  })

  const after = (await query(`select ${siteCol} site, sum(quantity)::int qty from ${stockTbl} where facility_id=$1 and ${siteCol} in ($2,$3) group by 1`, [F, fromName, toName])).rows
  console.log('\n✓ Merged. Site stock now:'); console.table(after.length ? after : [{ note: 'none — merged away' }])
} catch (err) {
  console.error('Merge failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
