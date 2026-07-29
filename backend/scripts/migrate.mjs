// Applies migrations/*.sql in filename order, tracking what's been run in
// schema_migrations. Each file runs inside its own transaction, so a failure
// leaves the database at the last good migration.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pool, { query, withTransaction } from '../src/db.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  const { rows } = await query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  let ran = 0;
  for (const filename of files) {
    if (applied.has(filename)) continue;

    const sql = await readFile(join(migrationsDir, filename), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    });
    console.log(`applied ${filename}`);
    ran += 1;
  }

  console.log(ran === 0 ? 'nothing to apply, database is up to date' : `${ran} migration(s) applied`);
}

main()
  .catch((err) => {
    console.error('migration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
