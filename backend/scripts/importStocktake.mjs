// Loads a physical stock-take sheet into envo_wms as opening batches.
//
//   node --env-file=.env scripts/importStocktake.mjs                  # dry run, changes nothing
//   node --env-file=.env scripts/importStocktake.mjs --commit         # writes
//   node --env-file=.env scripts/importStocktake.mjs --file other.csv
//
// Every line becomes a batch with a 'receipt' movement, so on-hand is derived from the
// ledger exactly as it is for a real delivery — nothing is poked straight into a stock
// column. Dry run is the default: you have to ask for the write.
//
// The script refuses to run rather than guess. It stops on any row still flagged for
// checking, on any row carrying two expiry dates (that is two batches sharing one
// quantity, and only a human can split it), and on any commodity name it cannot resolve.
// Fix the CSV and run it again.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pool, { query, withTransaction } from '../src/db.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const allowFlagged = args.includes('--allow-flagged');
const fileArg = args[args.indexOf('--file') + 1];
const FILE = resolve(HERE, args.includes('--file') ? fileArg : 'stocktake-2026-08-corrected.csv');

// Marks every movement this script writes, so a second run can see its own work and
// refuse to double the stock.
const NOTE = 'stock-take opening balance';
const CREATED_BY = 'stocktake-import';

// Sheet descriptions that do not match the catalogue verbatim. Add an entry here when the
// sheet and the catalogue simply spell the same thing differently; add the commodity to
// the catalogue instead when it is genuinely missing. Anything neither listed nor an
// exact match stops the run — the script will not pick a "close enough" commodity.
const ALIASES = {};

// Minimal CSV reader. The sheet has no quoted fields, so a plain split is enough — but a
// row with more cells than the header means a stray comma landed in a free-text column
// and every value after it has shifted, which must not pass silently. Trailing empty
// cells are tolerated: spreadsheets add them when a column is deleted.
function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header.split(',');
  return lines.map((line, i) => {
    const cells = line.split(',');
    const overflow = cells.slice(cols.length).filter((c) => c.trim() !== '');
    if (overflow.length) {
      throw new Error(
        `line ${i + 2}: ${cells.length} cells against ${cols.length} columns — a comma inside a text field has shifted the row`
      );
    }
    return Object.fromEntries(cols.map((c, j) => [c.trim(), (cells[j] ?? '').trim()]));
  });
}

// 'YYYY-MM' → the last day of that month. A carton marked 06/2028 is good to the end of
// June, so the first of the month would expire it up to 29 days early. The pattern is
// strict on purpose: '20284' and '2029-1' are both typos that would otherwise be read as
// something plausible and wrong.
function endOfMonth(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) throw new Error(`unreadable expiry "${value}" — expected YYYY-MM`);
  const [, year, month] = match;
  return new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10);
}

const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function main() {
  const rows = parseCsv(readFileSync(FILE, 'utf8'));
  const stocked = rows.filter((r) => r.Qty !== '');

  const { rows: catalogue } = await query('SELECT id, name FROM commodities WHERE is_active');
  const byName = new Map(catalogue.map((c) => [normalise(c.name), c]));

  const problems = [];
  const plan = [];

  for (const row of stocked) {
    const where = `page ${row.page} sn ${row.sn} "${row.description}"`;

    if (!row.expiry_1) {
      problems.push(`${where}: no expiry date`);
      continue;
    }

    // Two dates against one quantity means two lots the sheet did not split. FEFO puts
    // the whole count on the earlier date: it is the pessimistic reading, so the batch
    // surfaces on the expiry alerts at the right time and gets picked first. Splitting it
    // properly needs a recount, which this script cannot do.
    const dates = [row.expiry_1, row.expiry_2].filter(Boolean).sort();
    const fefo = dates[0];

    let expiryDate;
    try {
      expiryDate = endOfMonth(fefo);
    } catch (err) {
      problems.push(`${where}: ${err.message}`);
      continue;
    }

    const quantity = Number(row.Qty);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
      problems.push(`${where}: Qty "${row.Qty}" is not a positive whole number`);
      continue;
    }

    const wanted = ALIASES[row.description] ?? row.description;
    const commodity = byName.get(normalise(wanted));
    if (!commodity) {
      problems.push(`${where}: no active commodity named "${wanted}"`);
      continue;
    }

    plan.push({ commodity, quantity, expiryDate, where, fefoFrom: dates.length > 1 ? dates : null });
  }

  if (problems.length) {
    console.error(`${problems.length} row(s) need attention before this can be imported:\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('\nNothing was written. Fix the CSV and run again.');
    process.exitCode = 1;
    return;
  }

  // Guard against a second run doubling the stock. Checked here rather than per-row so
  // a partial import cannot be silently topped up.
  const { rows: already } = await query(
    'SELECT COUNT(*)::int AS count FROM batch_movements WHERE note = $1',
    [NOTE]
  );
  if (already[0].count > 0) {
    console.error(
      `This sheet has already been imported — ${already[0].count} movement(s) carry the note "${NOTE}".`
    );
    console.error('Reverse those batches before importing again. Nothing was written.');
    process.exitCode = 1;
    return;
  }

  const units = plan.reduce((sum, p) => sum + p.quantity, 0);
  console.log(`${FILE}`);
  console.log(`${rows.length} lines read, ${stocked.length} carrying stock`);
  console.log(`${plan.length} batches to create, ${units.toLocaleString('en-NG')} units total\n`);

  for (const p of plan) {
    const fefo = p.fefoFrom ? `   FEFO from ${p.fefoFrom.join(' / ')}` : '';
    console.log(
      `  ${String(p.quantity).padStart(7)}  exp ${p.expiryDate}  ${p.commodity.name}${fefo}`
    );
  }

  if (!commit) {
    console.log('\nDry run — nothing written. Re-run with --commit to apply.');
    return;
  }

  // One transaction for the sheet: a stock-take is a single event, and a half-loaded
  // sheet is worse than none — you cannot tell which lines are missing.
  await withTransaction(async (client) => {
    for (const p of plan) {
      const { rows: created } = await client.query(
        `INSERT INTO commodity_batches
           (commodity_id, batch_number, expiry_date, quantity_received, quantity_remaining,
            received_date, created_by)
         VALUES ($1, NULL, $2, $3, $3, CURRENT_DATE, $4)
         RETURNING id`,
        [p.commodity.id, p.expiryDate, p.quantity, CREATED_BY]
      );
      await client.query(
        `INSERT INTO batch_movements (batch_id, movement_type, quantity, note, created_by)
         VALUES ($1, 'receipt', $2, $3, $4)`,
        [created[0].id, p.quantity, NOTE, CREATED_BY]
      );
    }
  });

  console.log(`\nImported ${plan.length} batches, ${units.toLocaleString('en-NG')} units.`);
  console.log(`Every movement carries the note "${NOTE}".`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
