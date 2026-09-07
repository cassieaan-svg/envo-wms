// READ-ONLY. diagnose_phantom_openings.mjs, generalised: that script is deliberately
// scoped to STORE bins currently at SOH 0 (its own header explains why). A commodity
// with real stock and years of history can carry the exact same defect — the ledger's
// recorded outflows don't match its inflows — it's just buried under everything since,
// and invisible to a script that only looks at zero-stock bins.
//
// This scans EVERY bin of EVERY kind (store, dispensary, DSD site, SDP site) across
// the whole database (or one facility, with --facility), using the SAME per-bin model
// explain_bin_ledger.mjs verifies interactively:
//
//   store       received = intake + external transfer IN
//               issued   = external transfer OUT + internal redistribution OUT
//               adjust   = stock_adjustment_log rows with location_type NULL/'store'
//   dispensary  received = internal store->dispensary redistribution (untagged)
//               issued   = untagged dispensing + "Returned from Dispensary" (that
//                          credits the store, so it must leave here or this bin looks
//                          short by exactly the returned amount)
//               adjust   = stock_adjustment_log rows with location_type='dispensary'
//   dsd/sdp     same shape as dispensary, tag-matched to one site
//
// implied opening = current SOH - (received - issued + adjust), the same formula
// diagnose_phantom_openings.mjs and explain_bin_ledger.mjs both use. Not automatically
// wrong at zero: a bin with real pre-records history legitimately opens non-zero. What
// is worth a look is a LARGE one, especially a round number (an estimate standing in
// for a real count) or a bin whose whole history is short (little room for a real
// baseline to hide in).
//
//   cd C:\envo\app\backend
//   node scripts/audit_all_bin_openings.mjs                       # every bin, |opening| >= 50
//   node scripts/audit_all_bin_openings.mjs --min 200             # only the large ones
//   node scripts/audit_all_bin_openings.mjs --facility "NIMR"     # one facility
//   node scripts/audit_all_bin_openings.mjs --csv openings.csv    # full list to CSV
//
// Nothing is written. Each row it prints is a lead, not a verdict — run
// explain_bin_ledger.mjs on any one of them for the record-by-record detail before
// deciding REVERSE vs BASELINE (see opening_balance_plan.mjs).

import { pool, query } from '../src/db.js'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}
const MIN = Math.abs(parseInt(flag('min'), 10)) || 50
const FAC = flag('facility')
const csvPath = flag('csv')

const facCond = (alias) => FAC ? ` and ${alias}.name ilike $FACPARAM` : ''

async function storeOpenings() {
  const params = []
  let fc = ''
  if (FAC) { params.push(`%${FAC}%`); fc = ` and f.name ilike $${params.length}` }
  const { rows } = await query(`
    with intake as (
      select facility_id f, commodity_id c, sum(quantity)::int q from intake_log group by 1,2),
    adj as (
      select facility_id f, commodity_id c,
             sum(case when adjustment_type='Decrease' then -quantity else quantity end)::int q
      from stock_adjustment_log where coalesce(location_type,'store')='store' group by 1,2),
    tin as (
      select receiving_facility_id f, commodity_id c, sum(quantity)::int q from stock_transfer_log
      where status='accepted' and sending_facility_id is not null and receiving_facility_id is not null
        and sending_facility_id <> receiving_facility_id group by 1,2),
    tout as (
      select sending_facility_id f, commodity_id c, sum(quantity)::int q from stock_transfer_log
      where status in ('in_transit','dispatched','accepted') group by 1,2)
    select 'store' bin, s.facility_id, s.commodity_id, f.name facility, cm.name commodity, s.quantity soh,
           (coalesce(i.q,0)+coalesce(a.q,0)+coalesce(ti.q,0)-coalesce(to_.q,0)) record_net
      from stock s
      join facilities f on f.id=s.facility_id
      join commodities cm on cm.id=s.commodity_id
      left join intake i on i.f=s.facility_id and i.c=s.commodity_id
      left join adj a on a.f=s.facility_id and a.c=s.commodity_id
      left join tin ti on ti.f=s.facility_id and ti.c=s.commodity_id
      left join tout to_ on to_.f=s.facility_id and to_.c=s.commodity_id
     where s.location_type='store'${fc}`, params)
  return rows.map(r => ({ ...r, opening: r.soh - r.record_net }))
}

async function dispensaryOpenings() {
  const params = []
  let fc = ''
  if (FAC) { params.push(`%${FAC}%`); fc = ` and f.name ilike $${params.length}` }
  const { rows } = await query(`
    with tin as (
      select sending_facility_id f, commodity_id c, sum(quantity)::int q from stock_transfer_log
      where status='accepted' and (receiving_facility_id is null or receiving_facility_id=sending_facility_id)
        and coalesce(notes,'') !~* '\\[(DSD|SDP):' group by 1,2),
    disp as (
      select facility_id f, commodity_id c, sum(quantity)::int q from dispense_log
      where coalesce(notes,'') !~* '\\[(DSD|SDP):' group by 1,2),
    ret as (
      select facility_id f, commodity_id c, sum(quantity)::int q from stock_adjustment_log
      where reason='Returned from Dispensary' group by 1,2),
    adj as (
      select facility_id f, commodity_id c,
             sum(case when adjustment_type='Decrease' then -quantity else quantity end)::int q
      from stock_adjustment_log where location_type='dispensary' group by 1,2)
    select 'dispensary' bin, s.facility_id, s.commodity_id, f.name facility, cm.name commodity, s.quantity soh,
           (coalesce(ti.q,0)-coalesce(d.q,0)-coalesce(r.q,0)+coalesce(a.q,0)) record_net
      from stock s
      join facilities f on f.id=s.facility_id
      join commodities cm on cm.id=s.commodity_id
      left join tin ti on ti.f=s.facility_id and ti.c=s.commodity_id
      left join disp d on d.f=s.facility_id and d.c=s.commodity_id
      left join ret r on r.f=s.facility_id and r.c=s.commodity_id
      left join adj a on a.f=s.facility_id and a.c=s.commodity_id
     where s.location_type='dispensary'${fc}`, params)
  return rows.map(r => ({ ...r, opening: r.soh - r.record_net }))
}

async function siteOpenings(kind) {
  // kind: 'dsd' | 'sdp'
  const table = kind === 'dsd' ? 'dsd_stock' : 'sdp_stock'
  const col = kind === 'dsd' ? 'dsd_site_name' : 'sdp_name'
  const tag = kind.toUpperCase()
  const reason = kind === 'dsd' ? 'Returned from DSD' : 'Returned from SDP'
  const params = []
  let fc = ''
  if (FAC) { params.push(`%${FAC}%`); fc = ` and f.name ilike $${params.length}` }
  const { rows } = await query(`
    with tin as (
      select sending_facility_id f, commodity_id c,
             btrim((regexp_match(notes, '\\[${tag}:\\s*([^\\]]+)\\]'))[1]) site,
             sum(quantity)::int q
      from stock_transfer_log
      where status='accepted' and (receiving_facility_id is null or receiving_facility_id=sending_facility_id)
        and notes ~* '\\[${tag}:'
      group by 1,2,3),
    disp as (
      select facility_id f, commodity_id c,
             btrim((regexp_match(notes, '\\[${tag}:\\s*([^\\]]+)\\]'))[1]) site,
             sum(quantity)::int q
      from dispense_log where notes ~* '\\[${tag}:' group by 1,2,3),
    ret as (
      select facility_id f, commodity_id c,
             btrim((regexp_match(notes, 'Returned from [^:]*:\\s*([^—]+)'))[1]) site,
             sum(quantity)::int q
      from stock_adjustment_log where reason = '${reason}' group by 1,2,3),
    adj as (
      select facility_id f, commodity_id c, lower(btrim(coalesce(site_name,''))) site,
             sum(case when adjustment_type='Decrease' then -quantity else quantity end)::int q
      from stock_adjustment_log where location_type='${kind}' group by 1,2,3)
    select '${kind}' bin, s.facility_id, s.commodity_id, f.name facility, cm.name commodity,
           s.${col} site, s.quantity soh,
           (coalesce(ti.q,0)-coalesce(d.q,0)-coalesce(r.q,0)+coalesce(a.q,0)) record_net
      from ${table} s
      join facilities f on f.id=s.facility_id
      join commodities cm on cm.id=s.commodity_id
      left join tin ti on ti.f=s.facility_id and ti.c=s.commodity_id and lower(ti.site)=lower(btrim(s.${col}))
      left join disp d on d.f=s.facility_id and d.c=s.commodity_id and lower(d.site)=lower(btrim(s.${col}))
      left join ret r on r.f=s.facility_id and r.c=s.commodity_id and lower(r.site)=lower(btrim(s.${col}))
      left join adj a on a.f=s.facility_id and a.c=s.commodity_id and a.site=lower(btrim(s.${col}))
     where coalesce(btrim(s.${col}),'') <> ''${fc}`, params)
  return rows.map(r => ({ ...r, opening: r.soh - r.record_net }))
}

async function main() {
  const [store, dispensary, dsd, sdp] = await Promise.all([
    storeOpenings(), dispensaryOpenings(), siteOpenings('dsd'), siteOpenings('sdp'),
  ])
  const all = [...store, ...dispensary, ...dsd, ...sdp]
    .filter(r => Math.abs(r.opening) >= MIN)
    .sort((a, b) => Math.abs(b.opening) - Math.abs(a.opening))

  console.log(`\n${all.length} bin(s) with |implied opening| >= ${MIN}${FAC ? ` at facilities matching "${FAC}"` : ' (whole database)'}\n`)
  console.table(all.slice(0, 60).map(r => ({
    facility: r.facility.length > 30 ? r.facility.slice(0, 28) + '…' : r.facility,
    commodity: r.commodity.length > 26 ? r.commodity.slice(0, 24) + '…' : r.commodity,
    bin: r.bin + (r.site ? `:${r.site}` : ''),
    SOH: r.soh, record_net: r.record_net, opening: r.opening,
  })))
  if (all.length > 60) console.log(`… ${all.length - 60} more. Use --csv to export the full list.`)

  const round = all.filter(r => Math.abs(r.opening) % 100 === 0 && r.opening !== 0)
  if (round.length) {
    console.log(`\n${round.length} of these are round numbers (multiples of 100) — the pattern this codebase`)
    console.log(`already recognises as a stand-in estimate rather than a real count (see`)
    console.log(`diagnose_phantom_openings.mjs's header). Worth checking first.`)
  }

  if (csvPath) {
    const hdr = ['bin', 'facility', 'commodity', 'site', 'soh', 'record_net', 'opening']
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const out = [hdr, ...all.map(r => [r.bin, r.facility, r.commodity, r.site || '', r.soh, r.record_net, r.opening])]
    fs.writeFileSync(csvPath, out.map(r => r.map(esc).join(',')).join('\r\n'))
    console.log(`\nFull list (${all.length} rows) written to ${csvPath}`)
  }
  console.log('\nREAD-ONLY — nothing was modified. Run explain_bin_ledger.mjs on any one row for the detail.')
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => pool.end())
