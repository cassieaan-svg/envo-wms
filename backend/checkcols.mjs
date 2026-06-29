import { query } from './src/db.js'
const cid='d95dfa19-6ac8-4c3c-908a-44b91e5b6b3f'
const fid='e81c51b6-c12f-47df-b680-9ed8fe6ea724'
const cols = await query(`select column_name from information_schema.columns where table_name='stock' order by ordinal_position`)
console.log('STOCK COLUMNS:', cols.rows.map(r=>r.column_name).join(', '))
const s = await query(`select * from stock where commodity_id=$1 and facility_id=$2`,[cid,fid])
console.log('STOCK ROWS:', JSON.stringify(s.rows,null,2))
process.exit(0)
