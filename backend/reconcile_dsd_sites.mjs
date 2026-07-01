// Reconcile DSD stock site names to the DSD account's registered dsd_site_name.
// DRY-RUN by default. To actually write: APPLY=1 node reconcile_dsd_sites.mjs
//
// Order of operations (per mapping): MERGE colliding commodities first
// (add source qty into the existing target row, delete source), THEN RENAME the
// remaining source rows. Everything runs in ONE transaction; dry-run rolls back.
import 'dotenv/config'
import pg from 'pg'

const APPLY = process.env.APPLY === '1'

// Human-verified mappings: rename `from` -> `to` at `facility_id`. LEAVE EMPTY
// until you have run the audit below and copied the real facility_id, the exact
// orphan `from` name, and the correct registered `to` name. Example:
//   { facility_id: '<copy from ORPHAN STOCK NAMES audit>', from: 'ITELEWA', to: 'Ita Elewa PHC, Ikorodu' },
const MAPPINGS = [
]

const pool = new pg.Pool({ host: process.env.PGHOST, port: process.env.PGPORT, database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD })

async function orphanStockNames(client) {
  console.log('=== ORPHAN STOCK NAMES: dsd_stock site names with NO matching DSD account at that facility (the real rename candidates) ===')
  const { rows } = await client.query(`
    select d.facility_id, f.name as facility, d.dsd_site_name,
           count(*) as commodities, sum(d.quantity) as total_qty
    from dsd_stock d
    join facilities f on f.id = d.facility_id
    where not exists (
      select 1 from users u
      where u.raw_user_meta_data->>'facility_role' = 'dsd'
        and (u.raw_user_meta_data->>'facility_id')::uuid = d.facility_id
        and u.raw_user_meta_data->>'dsd_site_name' = d.dsd_site_name)
    group by 1,2,3 order by 2,3`)
  if (!rows.length) console.log('  (none)')
  rows.forEach(r => console.log(`  ${r.facility}  |  stock name: "${r.dsd_site_name}"  |  ${r.commodities} commodities, ${r.total_qty} units  |  facility_id: ${r.facility_id}`))
  console.log('')
}

async function audit(client) {
  console.log('=== AUDIT: DSD accounts whose site name has no matching dsd_stock at their facility ===')
  const { rows } = await client.query(`
    select u.email,
           u.raw_user_meta_data->>'dsd_site_name' as account_site,
           u.raw_user_meta_data->>'facility_id'   as facility_id,
           coalesce(array_agg(distinct d.dsd_site_name) filter (where d.dsd_site_name is not null), '{}') as stock_sites
    from users u
    left join dsd_stock d on d.facility_id = (u.raw_user_meta_data->>'facility_id')::uuid
    where u.raw_user_meta_data->>'facility_role' = 'dsd'
    group by 1,2,3
    having (u.raw_user_meta_data->>'dsd_site_name') <> all (coalesce(array_agg(distinct d.dsd_site_name), '{}'))
    order by 1`)
  if (!rows.length) console.log('  (none)')
  rows.forEach(r => console.log(`  ${r.email}\n    account_site: "${r.account_site}"\n    stock_sites : ${JSON.stringify(r.stock_sites)}`))
  console.log('')
}

async function applyMapping(client, m) {
  const src = (await client.query(
    `select commodity_id, quantity from dsd_stock where facility_id=$1 and dsd_site_name=$2`, [m.facility_id, m.from])).rows
  if (!src.length) { console.log(`  [${m.from} -> ${m.to}] no source rows; nothing to do`); return }
  let merged = 0, renamed = 0
  for (const s of src) {
    const tgt = (await client.query(
      `select id, quantity from dsd_stock where facility_id=$1 and dsd_site_name=$2 and commodity_id=$3`,
      [m.facility_id, m.to, s.commodity_id])).rows[0]
    if (tgt) {
      // MERGE: fold source qty into existing target, delete source
      await client.query(`update dsd_stock set quantity=quantity+$2, updated_at=now() where id=$1`, [tgt.id, s.quantity])
      await client.query(`delete from dsd_stock where facility_id=$1 and dsd_site_name=$2 and commodity_id=$3`, [m.facility_id, m.from, s.commodity_id])
      merged++
    } else {
      // RENAME: no collision
      await client.query(`update dsd_stock set dsd_site_name=$3, updated_at=now() where facility_id=$1 and dsd_site_name=$2 and commodity_id=$4`,
        [m.facility_id, m.from, m.to, s.commodity_id])
      renamed++
    }
  }
  console.log(`  [${m.from} -> ${m.to}] ${src.length} source rows: ${merged} merged, ${renamed} renamed`)
}

const client = await pool.connect()
try {
  await orphanStockNames(client)
  await audit(client)
  await client.query('begin')
  console.log(`=== ${APPLY ? 'APPLYING' : 'DRY-RUN (no writes will be kept)'} ===`)
  for (const m of MAPPINGS) await applyMapping(client, m)
  if (APPLY) { await client.query('commit'); console.log('\nCOMMITTED.') }
  else       { await client.query('rollback'); console.log('\nROLLED BACK (dry-run). Re-run with APPLY=1 to commit.') }
} catch (e) {
  await client.query('rollback').catch(()=>{})
  console.error('ERROR (rolled back):', e.message)
} finally { client.release(); await pool.end() }
