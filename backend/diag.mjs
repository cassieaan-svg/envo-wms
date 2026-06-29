import { query } from './src/db.js'

const commLike = '%ABC/3TC%'
const facLike  = '%Akere%'

const comm = await query(`select id,name,unit from commodities where name ilike $1`, [commLike])
console.log('COMMODITIES:', comm.rows)
const fac = await query(`select id,name,state,lga from facilities where name ilike $1`, [facLike])
console.log('FACILITIES:', fac.rows)

const cid = comm.rows[0]?.id
const fids = fac.rows.map(f=>f.id)

if (cid && fids.length) {
  const stock = await query(`select id,facility_id,location_type,quantity,updated_at from stock where commodity_id=$1 and facility_id=any($2) order by location_type`, [cid, fids])
  console.log('\nSTOCK rows:', stock.rows)

  const dsd = await query(`select id,facility_id,dsd_site_name,quantity from dsd_stock where commodity_id=$1 and facility_id=any($2)`, [cid, fids])
  console.log('DSD_STOCK:', dsd.rows)
  const sdp = await query(`select id,facility_id,sdp_name,quantity from sdp_stock where commodity_id=$1 and facility_id=any($2)`, [cid, fids])
  console.log('SDP_STOCK:', sdp.rows)

  const intake = await query(`select id,quantity,batch_number,expiry_date,received_at,notes from intake_log where commodity_id=$1 and facility_id=any($2) order by received_at desc limit 20`, [cid, fids])
  console.log('\nINTAKE_LOG:', intake.rows)

  const disp = await query(`select id,quantity,dispensed_at,notes from dispense_log where commodity_id=$1 and facility_id=any($2) order by dispensed_at desc limit 20`, [cid, fids])
  console.log('\nDISPENSE_LOG:', disp.rows)

  const tr = await query(`select id,sending_facility_id,receiving_facility_id,quantity,status,notes,initiated_at,resolved_at from stock_transfer_log where commodity_id=$1 and (sending_facility_id=any($2) or receiving_facility_id=any($2)) order by initiated_at desc limit 20`, [cid, fids])
  console.log('\nTRANSFER_LOG:', tr.rows)
}
process.exit(0)
