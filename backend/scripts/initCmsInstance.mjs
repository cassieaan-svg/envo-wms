// One-time preparation of a CMS Local database.
//
// Both instances mint ids from the same SERIAL sequences, so without this they would both
// eventually issue `dispatch_orders.id = 8` for different orders. `uid` is what crosses the
// wire, so a collision would not corrupt the sync — but it would make every local id
// ambiguous when a human compares the two systems, and any future code that reached for an
// integer id across the boundary would be quietly wrong.
//
// The fix is a disjoint range: Cloud keeps the low numbers, CMS starts at 1,000,000.
//
// It REFUSES rather than proceeds if Cloud has already grown past the floor, or if the
// database it is pointed at already holds warehouse transactions. Silently renumbering a
// live warehouse would be far worse than stopping and asking.
//
//   node scripts/initCmsInstance.mjs            # report what it would do
//   node scripts/initCmsInstance.mjs --commit   # apply
//
// Run it ONCE, on the CMS database, after migrations and before the first receipt.

import pool, { query } from '../src/db.js';

const CMS_ID_FLOOR = Number(process.env.CMS_ID_FLOOR || 1_000_000);
const commit = process.argv.includes('--commit');

// Only the sequences CMS authors from. Master data and requests are Cloud's to number, and
// CMS copies those ids verbatim — renumbering them would break the very references that make
// the mirror line up.
const CMS_AUTHORED = [
  'commodity_batches_id_seq',
  'batch_movements_id_seq',
  'dispatch_orders_id_seq',
  'dispatch_order_items_id_seq',
  'dispatch_order_payments_id_seq',
  'inventory_transactions_id_seq',
  'stock_discrepancies_id_seq',
];

try {
  const role = (process.env.WMS_ROLE || 'cloud').toLowerCase();
  if (role !== 'cms') {
    console.error(`refusing to run: WMS_ROLE is "${role}". This script prepares a CMS database.`);
    process.exit(1);
  }

  const { rows: [counts] } = await query(`
    SELECT (SELECT COUNT(*) FROM batch_movements)::int      AS movements,
           (SELECT COUNT(*) FROM inventory_transactions)::int AS txns,
           (SELECT COUNT(*) FROM commodity_batches)::int    AS batches`);

  console.log(`database: ${process.env.PGDATABASE}`);
  console.log(`existing: ${counts.batches} batches, ${counts.movements} movements, ${counts.txns} transactions`);

  if (counts.movements > 0 || counts.txns > 0) {
    console.error('');
    console.error('REFUSING: this database already holds warehouse transactions.');
    console.error('Renumbering sequences under live data would leave existing rows below the');
    console.error('CMS floor and new rows above it, which is confusing rather than dangerous —');
    console.error('but it is not something to do without deciding to. If this really is a fresh');
    console.error('CMS database, clear it first; if it is a copy of Cloud, take a fresh one.');
    process.exit(2);
  }

  const { rows: seqs } = await query(
    `SELECT sequencename, last_value FROM pg_sequences
      WHERE schemaname='public' AND sequencename = ANY($1) ORDER BY sequencename`,
    [CMS_AUTHORED]);

  const tooHigh = seqs.filter((s) => Number(s.last_value ?? 0) >= CMS_ID_FLOOR);
  if (tooHigh.length) {
    console.error('');
    console.error(`REFUSING: these sequences have already passed the CMS floor (${CMS_ID_FLOOR.toLocaleString()}):`);
    for (const s of tooHigh) console.error(`  ${s.sequencename} is at ${Number(s.last_value).toLocaleString()}`);
    console.error('Cloud and CMS would overlap. Raise CMS_ID_FLOOR above Cloud\'s highest value');
    console.error('and re-run, having checked that the new floor leaves Cloud room to grow.');
    process.exit(3);
  }

  console.log(`\nCMS id floor: ${CMS_ID_FLOOR.toLocaleString()}`);
  for (const s of seqs) {
    console.log(`  ${s.sequencename.padEnd(34)} ${String(s.last_value ?? 0).padStart(10)} -> ${CMS_ID_FLOOR}`);
  }

  if (!commit) {
    console.log('\nDry run — nothing changed. Re-run with --commit to apply.');
  } else {
    for (const s of seqs) {
      await query(`ALTER SEQUENCE ${s.sequencename} RESTART WITH ${CMS_ID_FLOOR}`);
    }
    console.log(`\n${seqs.length} sequence(s) moved to the CMS range. This database is ready to author warehouse transactions.`);
  }
} catch (err) {
  console.error('init failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
