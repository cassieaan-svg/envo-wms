// Seed / re-sync EnVo's Essential Commodities module from the WMS (the catalogue +
// price master). Pulls GET {WMS_API_URL}/api/catalogue/export (service-token auth) and:
//   1. upserts every WMS commodity into EnVo `commodities` as module='essential',
//      carrying its wms_commodity_id and current unit_price (display-only; the WMS
//      recomputes the authoritative total on a pick order);
//   2. enrolls the matching EnVo facilities into facility_modules(module='essential'),
//      mapping WMS.envo_facility_id -> EnVo.facilities.code, falling back to name.
//
// Idempotent: safe to re-run. Requires the WMS backend running and SERVICE_TOKEN +
// WMS_API_URL set in backend/.env.
//
// Run:  node scripts/seedEssentialCatalogue.mjs
import dotenv from 'dotenv'
dotenv.config()
import { query, withTransaction } from '../src/db.js'

const WMS_API_URL = process.env.WMS_API_URL || 'http://localhost:5100'
const SERVICE_TOKEN = process.env.SERVICE_TOKEN

async function fetchExport() {
  const res = await fetch(`${WMS_API_URL}/api/catalogue/export`, {
    headers: { 'x-service-token': SERVICE_TOKEN || '' },
  })
  if (!res.ok) throw new Error(`WMS export failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function seedCommodities(commodities) {
  let inserted = 0, updated = 0
  await withTransaction(async (exec) => {
    for (const c of commodities) {
      const { rows } = await exec(
        `insert into commodities (name, category, unit, module, wms_commodity_id, unit_price)
         values ($1, $2, $3, 'essential', $4, $5)
         on conflict (wms_commodity_id) where wms_commodity_id is not null
         do update set name = excluded.name,
                       category = excluded.category,
                       unit = excluded.unit,
                       unit_price = excluded.unit_price
         returning (xmax = 0) as is_insert`,
        [c.name, c.category, c.unit, c.wms_commodity_id, c.unit_price]
      )
      if (rows[0]?.is_insert) inserted++; else updated++
    }
  })
  return { inserted, updated }
}

async function enrollFacilities(wmsFacilities) {
  const { rows: envoFacs } = await query('select id, code, name from facilities')
  const byCode = new Map(envoFacs.filter(f => f.code).map(f => [f.code, f.id]))
  const byName = new Map(envoFacs.map(f => [f.name.toLowerCase().trim(), f.id]))

  const matchedIds = []
  const unmatched = []
  for (const wf of wmsFacilities) {
    const id = (wf.envo_facility_id && byCode.get(wf.envo_facility_id)) ||
               byName.get((wf.name || '').toLowerCase().trim())
    if (id) matchedIds.push(id); else unmatched.push(wf.name)
  }

  let enrolled = 0
  await withTransaction(async (exec) => {
    for (const id of matchedIds) {
      const { rowCount } = await exec(
        `insert into facility_modules (facility_id, module) values ($1, 'essential')
         on conflict do nothing`,
        [id]
      )
      enrolled += rowCount
    }
  })
  return { matched: matchedIds.length, newlyEnrolled: enrolled, unmatched }
}

async function main() {
  if (!SERVICE_TOKEN) throw new Error('SERVICE_TOKEN not set in backend/.env')
  console.log(`Pulling catalogue from ${WMS_API_URL} …`)
  const { commodities, facilities } = await fetchExport()
  console.log(`  received ${commodities.length} commodities, ${facilities.length} facilities`)

  const cRes = await seedCommodities(commodities)
  console.log(`Commodities: ${cRes.inserted} inserted, ${cRes.updated} updated`)

  const fRes = await enrollFacilities(facilities)
  console.log(`Facilities: ${fRes.matched} matched, ${fRes.newlyEnrolled} newly enrolled in 'essential'`)
  if (fRes.unmatched.length) {
    console.log(`  ${fRes.unmatched.length} WMS facilities had no EnVo match:`)
    fRes.unmatched.forEach(n => console.log(`    - ${n}`))
  }

  // Summary
  const { rows: cnt } = await query(
    `select count(*) filter (where module='essential')::int essential_commodities,
            count(*) filter (where module='essential' and unit_price is not null)::int priced,
            (select count(distinct facility_id) from facility_modules where module='essential')::int essential_facilities
       from commodities`
  )
  console.log('Now in EnVo:', cnt[0])
}

main().then(() => process.exit(0)).catch(err => { console.error('SEED FAILED:', err.message); process.exit(1) })
