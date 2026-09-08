// Removes every facility left untagged by the master-data import (facility_type IS NULL)
// — the old test register, now superseded by the primary/secondary master list.
//
//   node --env-file=.env scripts/purgeUntaggedFacilities.mjs            # dry run
//   node --env-file=.env scripts/purgeUntaggedFacilities.mjs --commit   # writes
//
// Most of these facilities have no history and delete cleanly. A handful have real
// dispatch orders, requests, or stock movements — for those, every batch_movements row
// tied to the facility is REVERSED (quantity_remaining restored by the same amount)
// before it is deleted, so no batch is left disagreeing with its own ledger. The balance
// guard added in migration 035 would otherwise trip the next time anyone touches that
// batch, for a reason that would no longer be visible in the ledger.
import { query, withTransaction } from '../src/db.js';

const commit = process.argv.includes('--commit');

async function main() {
  const { rows: untagged } = await query(
    'SELECT id, name, lga FROM facilities WHERE facility_type IS NULL ORDER BY id'
  );
  if (!untagged.length) {
    console.log('No untagged facilities — nothing to do.');
    return;
  }
  const ids = untagged.map((f) => f.id);

  const { rows: withHistory } = await query(
    `SELECT f.id, f.name,
            (SELECT count(*) FROM dispatch_orders o WHERE o.facility_id = f.id)::int AS orders,
            (SELECT count(*) FROM requests r WHERE r.facility_id = f.id)::int AS requests,
            (SELECT count(*) FROM batch_movements m WHERE m.facility_id = f.id)::int AS movements
       FROM facilities f
      WHERE f.id = ANY($1)
        AND (EXISTS (SELECT 1 FROM dispatch_orders o WHERE o.facility_id = f.id)
          OR EXISTS (SELECT 1 FROM requests r WHERE r.facility_id = f.id)
          OR EXISTS (SELECT 1 FROM batch_movements m WHERE m.facility_id = f.id))
      ORDER BY f.id`,
    [ids]
  );
  const historyIds = withHistory.map((f) => f.id);

  const { rows: reversals } = await query(
    `SELECT batch_id, SUM(quantity)::numeric AS total
       FROM batch_movements
      WHERE facility_id = ANY($1)
      GROUP BY batch_id`,
    [historyIds]
  );

  console.log(`Untagged facilities: ${untagged.length}`);
  console.log(`  with history (orders/requests/movements): ${withHistory.length}`);
  console.log(`  with no history at all: ${untagged.length - withHistory.length}\n`);

  console.log('Facilities with history — will be purged, stock effect reversed:');
  for (const f of withHistory) {
    console.log(
      `  #${f.id} ${f.name}  — ${f.orders} order(s), ${f.requests} request(s), ${f.movements} movement(s)`
    );
  }

  console.log('\nBatches whose stock will be restored:');
  for (const r of reversals) {
    // Movements are net negative (stock left), so restoring means adding back the
    // magnitude of what was deducted.
    console.log(`  batch #${r.batch_id}: quantity_remaining += ${(-Number(r.total)).toFixed(2)}`);
  }

  if (!commit) {
    console.log(
      `\nDry run — nothing written. ${untagged.length} facilities and their history would be permanently deleted. Re-run with --commit to apply.`
    );
    return;
  }

  await withTransaction(async (client) => {
    // 1. Reverse every history movement's effect on stock before it disappears.
    for (const r of reversals) {
      await client.query(
        'UPDATE commodity_batches SET quantity_remaining = quantity_remaining - $2 WHERE id = $1',
        [r.batch_id, r.total]
      );
    }

    // Order and request ids captured now — needed to scope inventory_transactions once
    // the rows that name them are gone.
    const { rows: orderRows } = await client.query(
      'SELECT id FROM dispatch_orders WHERE facility_id = ANY($1)',
      [historyIds]
    );
    const orderIds = orderRows.map((r) => r.id);
    const { rows: requestRows } = await client.query(
      'SELECT id FROM requests WHERE facility_id = ANY($1)',
      [historyIds]
    );
    const requestIds = requestRows.map((r) => r.id);

    // 2. batch_movements references inventory_transactions (restrict) — must go first.
    await client.query('DELETE FROM batch_movements WHERE facility_id = ANY($1)', [historyIds]);

    // 3. dispatch_order_payments also references inventory_transactions (restrict), and
    // is not yet gone — dispatch_orders hasn't cascaded to it. Explicit delete here.
    await client.query(
      'DELETE FROM dispatch_order_payments WHERE dispatch_order_id = ANY($1)',
      [orderIds]
    );

    // 4. Now inventory_transactions can go — nothing still references these rows.
    await client.query(
      'DELETE FROM inventory_transactions WHERE dispatch_order_id = ANY($1) OR request_id = ANY($2)',
      [orderIds, requestIds]
    );

    // 5. Requests before dispatch_orders — a fulfilled request points at the order it
    // produced (restrict FK), so it must go first.
    await client.query('DELETE FROM requests WHERE facility_id = ANY($1)', [historyIds]);

    // 6. Dispatch orders (cascades items and prints; payments already removed above).
    await client.query('DELETE FROM dispatch_orders WHERE facility_id = ANY($1)', [historyIds]);

    // 7. Everything else that references a facility (cascades where the FK allows it,
    // explicit here where it doesn't).
    await client.query('DELETE FROM facility_commodities WHERE facility_id = ANY($1)', [ids]);
    await client.query('DELETE FROM facility_stock_cache WHERE facility_id = ANY($1)', [ids]);

    // 8. The facilities themselves.
    const { rowCount } = await client.query('DELETE FROM facilities WHERE id = ANY($1)', [ids]);
    console.log(`Deleted ${rowCount} facilities.`);
  });

  console.log(`Restored stock on ${reversals.length} batch(es).`);
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    const pool = (await import('../src/db.js')).default;
    pool.end();
  });
