// Makes the stock-take the baseline: zeroes every batch that predates it, so the counted
// figures stand alone instead of stacking on top of whatever was already recorded.
//
//   node --env-file=.env scripts/baselineStocktake.mjs            # dry run
//   node --env-file=.env scripts/baselineStocktake.mjs --commit   # writes
//
// Nothing is deleted. Each superseded batch gets an 'adjustment' movement for the
// negative of what it still held, and its remaining quantity goes to zero. The batch, its
// original receipt, and any dispatches off it stay in the ledger — a physical recount
// corrects the record forward, it does not erase what the record used to say.
//
// Only commodities the count sheet actually reached are touched. The August 2026 sheets
// cover tablets and injections; syrups, infusions and consumables were not counted, and
// zeroing those would read as "we have none" when what is true is "nobody looked".
import pool, { query, withTransaction } from '../src/db.js';

const commit = process.argv.includes('--commit');

const IMPORT_TAG = 'stocktake-import';
const NOTE = 'superseded by the 2026-08 physical count';

async function main() {
  const { rows: stale } = await query(
    `SELECT b.id, b.quantity_remaining, b.batch_number, b.created_by, c.name
       FROM commodity_batches b
       JOIN commodities c ON c.id = b.commodity_id
      WHERE b.created_by IS DISTINCT FROM $1
        AND b.quantity_remaining > 0
        AND EXISTS (
          SELECT 1 FROM commodity_batches s
           WHERE s.commodity_id = b.commodity_id AND s.created_by = $1
        )
      ORDER BY b.quantity_remaining DESC`,
    [IMPORT_TAG]
  );

  const { rows: untouched } = await query(
    `SELECT c.category, COUNT(*)::int n, SUM(b.quantity_remaining)::numeric units
       FROM commodity_batches b
       JOIN commodities c ON c.id = b.commodity_id
      WHERE b.created_by IS DISTINCT FROM $1
        AND b.quantity_remaining > 0
        AND NOT EXISTS (
          SELECT 1 FROM commodity_batches s
           WHERE s.commodity_id = b.commodity_id AND s.created_by = $1
        )
      GROUP BY c.category
      ORDER BY SUM(b.quantity_remaining) DESC`,
    [IMPORT_TAG]
  );

  // Invented lot codes are worse than no lot code: they look like something you could
  // check against a carton. Cleared wherever they sit on a superseded batch.
  const { rows: placeholders } = await query(
    `SELECT b.id, b.batch_number, c.name
       FROM commodity_batches b
       JOIN commodities c ON c.id = b.commodity_id
      WHERE b.batch_number IS NOT NULL
        AND b.created_by IS DISTINCT FROM $1
        AND EXISTS (
          SELECT 1 FROM commodity_batches s
           WHERE s.commodity_id = b.commodity_id AND s.created_by = $1
        )`,
    [IMPORT_TAG]
  );

  const units = stale.reduce((sum, b) => sum + Number(b.quantity_remaining), 0);

  console.log(`${stale.length} batch(es) to zero, ${units.toLocaleString('en-NG')} units`);
  for (const b of stale.slice(0, 20)) {
    console.log(`  ${String(b.quantity_remaining).padStart(12)}  ${b.name}  (${b.created_by || 'unknown'})`);
  }
  if (stale.length > 20) console.log(`  … and ${stale.length - 20} more`);

  console.log(`\n${placeholders.length} placeholder batch number(s) to clear`);
  for (const p of placeholders) console.log(`  ${p.batch_number}  ${p.name}`);

  console.log('\nLeft alone — never reached by the count sheet:');
  for (const u of untouched) {
    console.log(`  ${u.category}: ${u.n} batch(es), ${Number(u.units).toLocaleString('en-NG')} units`);
  }

  if (!commit) {
    console.log('\nDry run — nothing written. Re-run with --commit to apply.');
    return;
  }

  await withTransaction(async (client) => {
    for (const b of stale) {
      await client.query(
        `INSERT INTO batch_movements (batch_id, movement_type, quantity, note, created_by)
         VALUES ($1, 'adjustment', $2, $3, $4)`,
        [b.id, -Number(b.quantity_remaining), NOTE, IMPORT_TAG]
      );
      await client.query('UPDATE commodity_batches SET quantity_remaining = 0 WHERE id = $1', [
        b.id,
      ]);
    }
    for (const p of placeholders) {
      await client.query('UPDATE commodity_batches SET batch_number = NULL WHERE id = $1', [p.id]);
    }
  });

  console.log(
    `\nZeroed ${stale.length} batch(es), ${units.toLocaleString('en-NG')} units, and cleared ${placeholders.length} placeholder batch number(s).`
  );
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
