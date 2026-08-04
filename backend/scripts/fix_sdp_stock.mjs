// One-off, PRODUCTION data correction for a single SDP/DSD site's stock.
// Safe by construction: step 1 lists every site consumption with its id, then you
// delete BY EXACT ID and set the site's stock to a target — nothing is guessed.
//
// Step 1 — see the records (read-only):
//   node scripts/fix_sdp_stock.mjs "Ekpene Obom" "Alere Determine" "Main Lab"
//
// Step 2 — apply (delete the bogus consumptions, set the site to 62):
//   node scripts/fix_sdp_stock.mjs "Ekpene Obom" "Alere Determine" "Main Lab" --delete <id1>,<id2> --set 62 --apply
//
// On apply, in ONE transaction: deletes the named dispense_log rows (verified to
// belong to this site), sets sdp_stock to --set, and reconciles the site's lot
// ledger to match (trimming FEFO / preserving batch). --apply omitted = dry run.

import { pool, query, withTransaction } from '../src/db.js'
import { LotService } from '../src/services/lotService.js'

const argv = process.argv.slice(2)
const flags = {}
const pos = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--apply') flags.apply = true
  else if (argv[i] === '--delete') flags.delete = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean)
  else if (argv[i] === '--set') flags.set = parseInt(argv[++i])
  else pos.push(argv[i])
}
const [facArg, commArg, siteArg] = pos
if (!facArg || !commArg || !siteArg) {
  console.error('Usage: node scripts/fix_sdp_stock.mjs "<facility>" "<commodity>" "<site>" [--delete id1,id2 --set N --apply]')
  process.exit(1)
}
const d = v => v ? new Date(v).toISOString().slice(0, 10) : '—'

try {
  const fac = (await query(`select id, name from facilities where name ilike $1`, [`%${facArg}%`])).rows
  const comm = (await query(`select id, name from commodities where name ilike $1`, [`%${commArg}%`])).rows
  if (fac.length !== 1) { console.log('Facility not unique:', fac.map(f => f.name)); process.exit(1) }
  if (comm.length !== 1) { console.log('Commodity not unique:', comm.map(c => c.name)); process.exit(1) }
  const F = fac[0].id, C = comm[0].id
  console.log(`\n${fac[0].name} · ${comm[0].name} · SDP "${siteArg}"\n`)

  // Site consumptions (dispense_log rows tagged [SDP: <site>]).
  const disps = (await query(
    `select id, dispensed_at t, quantity q, notes from dispense_log
      where facility_id=$1 and commodity_id=$2 and notes ilike $3 order by dispensed_at`,
    [F, C, `%[SDP: ${siteArg}]%`])).rows
  console.log('── Site consumptions (delete BY id) ──')
  console.table(disps.map(r => ({ id: r.id, date: d(r.t), qty: r.q, note: (r.notes || '').slice(0, 44) })))

  const soh = (await query(`select quantity from sdp_stock where facility_id=$1 and commodity_id=$2 and sdp_name=$3`, [F, C, siteArg])).rows[0]?.quantity ?? null
  const lots = (await query(`select batch_number, to_char(expiry_date,'YYYY-MM-DD') exp, quantity from stock_lot
                              where facility_id=$1 and commodity_id=$2 and location_type='sdp' and coalesce(site_name,'')=$3`, [F, C, siteArg])).rows
  console.log(`current sdp_stock: ${soh}`)
  console.log('current lot ledger:'); console.table(lots.length ? lots : [{ note: 'none' }])

  if (!flags.delete && flags.set == null) {
    console.log('\nRead-only. To apply, re-run with:  --delete <id,id> --set <target> --apply')
    process.exit(0)
  }
  if (!flags.delete?.length || !Number.isFinite(flags.set)) {
    console.error('\nBoth --delete <ids> and --set <target> are required to apply.'); process.exit(1)
  }
  // Guard: every id to delete must be one of THIS site's listed consumptions.
  const valid = new Set(disps.map(r => r.id))
  const bad = flags.delete.filter(id => !valid.has(id))
  if (bad.length) { console.error('\nThese ids are NOT consumptions of this site — refusing:', bad); process.exit(1) }

  console.log(`\nPLAN: delete ${flags.delete.length} consumption row(s) [${flags.delete.map(i => i.slice(0, 8)).join(', ')}], then set the site to ${flags.set} (ledger reconciled to match).`)
  if (!flags.apply) { console.log('DRY RUN — add --apply to execute.'); process.exit(0) }

  await withTransaction(async exec => {
    await exec(`delete from dispense_log where id = any($1::uuid[])`, [flags.delete])
    await exec(`insert into sdp_stock (facility_id, commodity_id, sdp_name, quantity) values ($1,$2,$3,$4)
                on conflict (facility_id, commodity_id, sdp_name) do update set quantity=$4, updated_at=now()`, [F, C, siteArg, flags.set])
    // Snap the site's lot ledger to the new SOH (trims FEFO / tops up if short).
    await LotService.reconcile(exec, { facility_id: F, commodity_id: C, location_type: 'sdp', site_name: siteArg })
  })

  const after = (await query(`select quantity from sdp_stock where facility_id=$1 and commodity_id=$2 and sdp_name=$3`, [F, C, siteArg])).rows[0]?.quantity
  const ledger = (await query(`select coalesce(sum(quantity),0) t from stock_lot where facility_id=$1 and commodity_id=$2 and location_type='sdp' and coalesce(site_name,'')=$3`, [F, C, siteArg])).rows[0].t
  console.log(`\n✓ Done. sdp_stock = ${after}, lot ledger sum = ${ledger}.`)
} catch (err) {
  console.error('Fix failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
