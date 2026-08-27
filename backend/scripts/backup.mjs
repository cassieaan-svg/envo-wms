// Local database backup for the CMS instance.
//
// Between syncs, this machine is the ONLY place the warehouse's stock exists. Cloud is a
// mirror that lags, and during an outage it lags by the whole outage — so a disk failure at
// the wrong moment loses every movement since the last successful sync. That is the risk
// this exists to bound.
//
// The agreed target is an RPO of one hour: at most an hour of warehouse work may be lost.
// Run it hourly from the OS scheduler (Task Scheduler on Windows):
//
//   node scripts/backup.mjs                      # hourly dump, prunes old ones
//   node scripts/backup.mjs --verify             # also restore-check the newest dump
//
// A successful sync to Cloud is itself a second copy, which is a good reason to sync often —
// but it is not a backup: Cloud holds no local-only rows (batch_balance_variance, the outbox)
// and cannot be restored FROM here in one step.

import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import pool, { query } from '../src/db.js';

const DIR = process.env.BACKUP_DIR || 'C:/envo-wms-backups';
const KEEP_HOURLY = Number(process.env.BACKUP_KEEP_HOURLY || 48);   // two days of hourly
const KEEP_DAILY = Number(process.env.BACKUP_KEEP_DAILY || 30);
const verify = process.argv.includes('--verify');

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

try {
  await mkdir(DIR, { recursive: true });

  // What is at risk right now, recorded alongside the dump so a restore can be judged
  // rather than guessed at: unsynced transactions are the work Cloud does not have.
  const { rows: [risk] } = await query(`
    SELECT (SELECT COUNT(*) FROM inventory_transactions WHERE synced_at IS NULL)::int AS unsynced,
           (SELECT MIN(created_at) FROM inventory_transactions WHERE synced_at IS NULL) AS oldest_unsynced,
           (SELECT COUNT(*) FROM batch_movements)::int AS movements`);

  const file = join(DIR, `${process.env.PGDATABASE}-${stamp()}.dump`);

  // Custom format: compressed, and restorable selectively with pg_restore.
  await run('pg_dump', [
    '--format=custom', '--no-owner', '--no-privileges',
    '--dbname', process.env.PGDATABASE,
    '--host', process.env.PGHOST || 'localhost',
    '--port', String(process.env.PGPORT || 5432),
    '--username', process.env.PGUSER,
    '--file', file,
  ], { PGPASSWORD: process.env.PGPASSWORD || '' });

  const { size } = await stat(file);
  console.log(`backup written: ${file} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`at risk if this machine is lost before the next sync: ${risk.unsynced} transaction(s)` +
              (risk.oldest_unsynced ? `, oldest ${new Date(risk.oldest_unsynced).toISOString()}` : ''));
  console.log(`ledger size: ${risk.movements} movements`);

  if (verify) {
    // A backup nobody has restored is a hope, not a backup. This only checks the archive is
    // readable and complete — a full restore drill belongs in the runbook, not in a cron job.
    await run('pg_restore', ['--list', file]);
    console.log('archive verified readable');
  }

  // Keep every dump from the last KEEP_HOURLY hours, then one per day beyond that.
  const now = Date.now();
  const kept = new Set();
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.dump')).sort().reverse();
  for (const f of files) {
    const s = await stat(join(DIR, f));
    const ageHours = (now - s.mtimeMs) / 3_600_000;
    if (ageHours <= KEEP_HOURLY) continue;
    if (ageHours > KEEP_DAILY * 24) { await unlink(join(DIR, f)); continue; }
    const day = new Date(s.mtimeMs).toISOString().slice(0, 10);
    if (kept.has(day)) await unlink(join(DIR, f));
    else kept.add(day);
  }
} catch (err) {
  // Loud: a silent backup failure is how a warehouse discovers, weeks later, that it has none.
  console.error('BACKUP FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
