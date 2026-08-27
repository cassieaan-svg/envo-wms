// Reconcile every batch against its movement ledger.
//
//   node scripts/reconcile.mjs           # report only, writes nothing
//   node scripts/reconcile.mjs --record  # also record findings in stock_discrepancies
//
// Exit code is 0 when everything agrees and 1 when it does not, so this can be run from a
// scheduled task and noticed when it fails.
//
// It never corrects anything. A variance means either stock moved without a movement or a
// movement was written without the stock moving; both need a person to find out which.
// Putting it right is a physical count raised as a `count_correction` adjustment, which
// leaves its own signed row in the ledger.

import pool from '../src/db.js';
import { ReconciliationService } from '../src/services/reconciliationService.js';

const record = process.argv.includes('--record');

try {
  const result = record
    ? await ReconciliationService.run({ source: 'scripts/reconcile.mjs' })
    : { discrepancies: await ReconciliationService.check() };

  const found = result.discrepancies;

  if (!found.length) {
    console.log('reconciliation ok — every batch agrees with its ledger');
    process.exitCode = 0;
  } else {
    console.log(`${found.length} batch(es) out of balance:\n`);
    console.log(
      ['batch', 'commodity', 'lot', 'expected', 'actual', 'variance'].join('\t')
    );
    for (const d of found) {
      console.log([
        d.batchId,
        d.commodityName,
        d.batchNumber ?? '(unlabelled)',
        d.expected,
        d.actual,
        d.variance > 0 ? `+${d.variance}` : d.variance,
      ].join('\t'));
    }
    console.log(
      record
        ? `\n${result.recorded} finding(s) recorded in stock_discrepancies. Nothing was corrected.`
        : '\nNothing was recorded or corrected. Re-run with --record to log these findings.'
    );
    process.exitCode = 1;
  }
} catch (err) {
  console.error('reconciliation failed:', err.message);
  process.exitCode = 2;
} finally {
  await pool.end();
}
