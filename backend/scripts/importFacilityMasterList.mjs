// Loads the Akwa Ibom facility master data — secondary hospitals and primary health
// centres — from facility_master.csv (name, lga, facility_type; normalised from the
// source spreadsheets), tags each with its type, and tags the pre-existing test
// facilities against the same master list by name.
//
//   node --env-file=.env scripts/importFacilityMasterList.mjs                # dry run
//   node --env-file=.env scripts/importFacilityMasterList.mjs --commit       # writes
//
// Safe to re-run: new facilities are matched on (name, lga) and skipped if already
// present; existing-facility tagging only ever sets facility_type, never touches anything
// else, and never overwrites a type that's already set.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, withTransaction } from '../src/db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const commit = process.argv.includes('--commit');
const CSV_FILE = resolve(HERE, 'facility_master.csv');
const STATE = 'Akwa Ibom';

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// CSV reader that understands quoted fields — a handful of facility names carry a comma
// (e.g. "General Hospital Ikpe Ikot Nkon, Ini"), which Python's csv writer quotes and a
// naive split(',') would silently shred.
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = parseCsvLine(header);
  return lines.map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

async function main() {
  const master = parseCsv(readFileSync(CSV_FILE, 'utf8'));
  const secondaryCount = master.filter((m) => m.facility_type === 'secondary').length;
  const primaryCount = master.filter((m) => m.facility_type === 'primary').length;

  console.log(`${CSV_FILE}`);
  console.log(`Secondary: ${secondaryCount}  ·  Primary: ${primaryCount}  ·  Total: ${master.length}\n`);

  const { rows: existing } = await query(
    'SELECT id, name, lga, facility_type FROM facilities ORDER BY id'
  );

  // New facilities: not already present under the same (name, lga) pair, matched loosely
  // (case/punctuation-insensitive) so a spelling difference doesn't create a duplicate the
  // sheet didn't actually introduce.
  const existingKey = new Set(existing.map((f) => `${norm(f.name)}|${norm(f.lga || '')}`));
  const toInsert = master.filter((m) => !existingKey.has(`${norm(m.name)}|${norm(m.lga)}`));

  // Existing (test) facilities: tag facility_type by exact name match against the master
  // list. A name that appears under both types, or at conflicting LGAs, is ambiguous for
  // a name-only lookup — left untagged rather than guessed.
  const masterByName = new Map();
  for (const m of master) {
    const key = norm(m.name);
    if (masterByName.has(key) && masterByName.get(key) !== m.facility_type) {
      masterByName.set(key, 'AMBIGUOUS');
    } else {
      masterByName.set(key, m.facility_type);
    }
  }
  const toTag = existing
    .filter((f) => f.facility_type == null)
    .map((f) => ({ ...f, matched: masterByName.get(norm(f.name)) }))
    .filter((f) => f.matched && f.matched !== 'AMBIGUOUS');
  const taggedIds = new Set(toTag.map((f) => f.id));
  const untagged = existing.filter((f) => f.facility_type == null && !taggedIds.has(f.id));

  console.log(`New facilities to insert:                     ${toInsert.length}`);
  console.log(`Existing facilities to tag by name match:      ${toTag.length}`);
  console.log(`Existing facilities left untagged (no match):  ${untagged.length}\n`);

  console.log('Sample of new inserts:');
  for (const m of toInsert.slice(0, 8)) {
    console.log(`  [${m.facility_type}] ${m.name}  (${m.lga})`);
  }
  if (toInsert.length > 8) console.log(`  … and ${toInsert.length - 8} more`);

  console.log('\nExisting facilities being tagged:');
  for (const f of toTag) {
    console.log(`  #${f.id} ${f.name} (${f.lga}) -> ${f.matched}`);
  }

  if (untagged.length) {
    console.log('\nExisting facilities with no match in either sheet (left NULL):');
    for (const f of untagged) console.log(`  #${f.id} ${f.name} (${f.lga || 'no LGA'})`);
  }

  if (!commit) {
    console.log('\nDry run — nothing written. Re-run with --commit to apply.');
    return;
  }

  await withTransaction(async (client) => {
    for (const m of toInsert) {
      await client.query(
        `INSERT INTO facilities (name, state, lga, facility_type)
         VALUES ($1, $2, $3, $4)`,
        [m.name, STATE, m.lga, m.facility_type]
      );
    }
    for (const f of toTag) {
      await client.query(
        'UPDATE facilities SET facility_type = $2 WHERE id = $1 AND facility_type IS NULL',
        [f.id, f.matched]
      );
    }
  });

  console.log(
    `\nInserted ${toInsert.length} facilities, tagged ${toTag.length} existing facilities.`
  );
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
