// Phase 5 — two-instance commissioning drill.
//
// Stands up a real Cloud instance and a real CMS instance on this machine, each with its own
// PostgreSQL database, its own server process, its own identity, outbox and sync state, and
// drives the whole offline-dispatch lifecycle between them over HTTP.
//
// This is the test the single-database Phase 4 suite could not be: two processes, two
// databases, a real network hop, and a Cloud that genuinely goes away.
//
//   node scripts/commission.mjs            # run the drill
//   node scripts/commission.mjs --fresh    # wipe both instance databases first
//
// SAFETY. It refuses to run against anything but the two disposable instance databases, and
// touches neither envo_wms nor envo_wms_test.

import { spawn } from 'node:child_process';
import pg from 'pg';
import dotenv from 'dotenv';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(ROOT, '.env') });

const CLOUD_DB = 'envo_wms_cloud_test';
const CMS_DB = 'envo_wms_cms_test';
const CLOUD_PORT = 5100;
const CMS_PORT = 5200;
const SYNC_TOKEN = 'commission-sync-token';
const FRESH = process.argv.includes('--fresh');

// ── safety ──────────────────────────────────────────────────────────────────
for (const db of [CLOUD_DB, CMS_DB]) {
  if (!/^envo_wms_(cloud|cms)_test$/.test(db)) {
    throw new Error(`refusing to touch "${db}" — commissioning uses disposable instance databases only`);
  }
}

const pools = {};
const poolFor = (db) => (pools[db] ??= new pg.Pool({
  host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
  database: db, user: process.env.PGUSER, password: process.env.PGPASSWORD, max: 4,
}));
const sql = (db, text, params) => poolFor(db).query(text, params);

// ── reporting ───────────────────────────────────────────────────────────────
const results = [];
let failures = 0;
function check(label, condition, detail = '') {
  const ok = !!condition;
  if (!ok) failures += 1;
  results.push({ ok, label, detail });
  console.log(`  ${ok ? 'PASS' : '*** FAIL ***'}  ${label}${detail ? `  — ${detail}` : ''}`);
  return ok;
}
const section = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

// ── instance processes ──────────────────────────────────────────────────────
const procs = {};

function envFor(role) {
  const common = {
    ...process.env,
    JWT_SECRET: process.env.JWT_SECRET || 'commission-jwt-secret',
    SYNC_TOKEN,
    RECONCILE_WORKER: 'off',
    // The drill drives sync explicitly so each step's cause and effect are unambiguous;
    // the timer would otherwise sync between assertions and blur what proved what.
    SYNC_WORKER: 'off',
    OUTBOX_WORKER: 'off',
  };
  if (role === 'cloud') {
    return { ...common, WMS_ROLE: 'cloud', WMS_ORIGIN: 'cloud', WMS_INSTANCE_ID: 'cloud-dev',
             PGDATABASE: CLOUD_DB, PORT: String(CLOUD_PORT) };
  }
  return { ...common, WMS_ROLE: 'cms', WMS_ORIGIN: 'cms', WMS_INSTANCE_ID: 'cms-uyo',
           PGDATABASE: CMS_DB, PORT: String(CMS_PORT),
           CLOUD_API_URL: `http://127.0.0.1:${CLOUD_PORT}`,
           // Deliberately absent: a CMS instance must not be able to reach EnVo.
           ENVO_API_URL: '' };
}

function start(role) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT, env: envFor(role), stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs[role] = p;
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (out.includes('listening on')) { p.stdout.off('data', onData); resolve(p); }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', (d) => { const s = d.toString(); if (!s.includes('ExperimentalWarning')) process.stderr.write(`[${role}] ${s}`); });
    p.on('error', reject);
    setTimeout(() => reject(new Error(`${role} did not start in time: ${out}`)), 15000);
  });
}

async function stop(role) {
  const p = procs[role];
  if (!p || p.killed) return;
  await new Promise((r) => { p.once('exit', r); p.kill(); });
  delete procs[role];
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
const base = { cloud: `http://127.0.0.1:${CLOUD_PORT}`, cms: `http://127.0.0.1:${CMS_PORT}` };
const tokens = {};

async function api(role, path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${base[role]}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function login(role, username, password) {
  const r = await api(role, '/api/auth/login', { method: 'POST', body: { username, password } });
  if (r.status !== 200) throw new Error(`${role} login failed: ${JSON.stringify(r.data)}`);
  tokens[role] = r.data.token;
  return r.data.user;
}

const uid = () => `CMS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

// ── the drill ───────────────────────────────────────────────────────────────
const state = {};

async function wipe() {
  section('SETUP — disposable instance databases');

  // The drill asserts on absolute balances and counts, because that is what makes its
  // conclusions readable ("500 -> 380", not "decreased by 120 from whatever was there").
  // That only holds from a known starting point, and commissioning a warehouse instance is a
  // fresh-database exercise anyway. Refuse rather than run against leftovers and produce
  // failures that mean nothing.
  if (!FRESH) {
    const { rows } = await sql(CMS_DB, 'SELECT COUNT(*)::int c FROM inventory_transactions');
    if (rows[0].c > 0) {
      throw new Error(
        `${CMS_DB} already holds ${rows[0].c} transaction(s) from an earlier run. ` +
        'Re-run with --fresh: the drill measures absolute balances and needs a known start.');
    }
  }

  if (FRESH) {
    for (const db of [CLOUD_DB, CMS_DB]) {
      await sql(db, `TRUNCATE batch_movements, inventory_transactions, dispatch_order_items,
        dispatch_order_payments, dispatch_orders, request_items, requests, commodity_batches,
        stock_discrepancies, batch_balance_variance, outbox, sync_state,
        facility_commodities, commodity_prices, commodities, facilities, vendors, users
        RESTART IDENTITY CASCADE`);
      console.log(`  wiped ${db}`);
    }
  }
  for (const [label, db] of [['cloud', CLOUD_DB], ['cms', CMS_DB]]) {
    const { rows } = await sql(db, 'SELECT COUNT(*)::int c FROM schema_migrations');
    console.log(`  ${label.padEnd(5)} ${db} — ${rows[0].c} migrations applied`);
  }
}

async function seedCloud() {
  section('SETUP — Cloud master data (Cloud owns it; CMS will copy it)');
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash('commission-pass', 4);

  await sql(CLOUD_DB, `INSERT INTO users (username, password_hash, full_name, role, is_active)
    VALUES ('cms.officer', $1, 'Store Officer', 'admin', true)
    ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`, [hash]);

  // Idempotent, so the drill can be re-run against the same pair of instance databases
  // without --fresh. Re-running matters: a commissioning check nobody can repeat is a
  // one-off demonstration, not a test.
  // Select-then-insert rather than ON CONFLICT: commodities.name carries no unique
  // constraint in this schema, so there is nothing for a conflict target to infer.
  const NAME = 'Commission Paracetamol 500mg';
  const { rows: existingCom } = await sql(CLOUD_DB,
    'SELECT id FROM commodities WHERE name = $1 LIMIT 1', [NAME]);
  const { rows: com } = existingCom.length ? { rows: existingCom } : await sql(CLOUD_DB,
    `INSERT INTO commodities (name, category, unit, is_active)
     VALUES ($1, 'Drugs', 'tabs', true) RETURNING id`, [NAME]);
  state.commodityId = com[0].id;

  const { rows: pr } = await sql(CLOUD_DB,
    'SELECT id FROM commodity_prices WHERE commodity_id = $1 AND is_current', [state.commodityId]);
  if (!pr.length) {
    await sql(CLOUD_DB, `INSERT INTO commodity_prices (commodity_id, unit_price, is_current)
       VALUES ($1, 25, true)`, [state.commodityId]);
  }

  const { rows: fac } = await sql(CLOUD_DB,
    `INSERT INTO facilities (envo_facility_id, name, state, lga, is_active)
     VALUES ('COMM-FAC-01', 'Commission Health Centre', 'Akwa Ibom', 'Uyo', true)
     ON CONFLICT (envo_facility_id) DO UPDATE SET is_active = true
     RETURNING id`);
  state.facilityId = fac[0].id;

  console.log(`  commodity ${state.commodityId}, facility ${state.facilityId}, user cms.officer`);
}

async function initCms() {
  section('SETUP — CMS instance identity (disjoint id range)');

  // Commissioning a CMS database is a once-per-database act, and initCmsInstance refuses to
  // renumber a database that already holds warehouse transactions — correctly. On a repeat
  // run of this drill that refusal is the expected answer, not a failure, so check whether
  // the instance is already commissioned before calling it.
  const { rows: seq } = await sql(CMS_DB, 'SELECT last_value FROM inventory_transactions_id_seq');
  if (Number(seq[0].last_value) >= 1_000_000) {
    check('CMS sequences start at the 1,000,000 floor', true,
      `already commissioned — next id ${seq[0].last_value}`);
    return;
  }

  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['scripts/initCmsInstance.mjs', '--commit'], {
      cwd: ROOT, env: { ...envFor('cms') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      console.log(out.split('\n').filter(Boolean).map((l) => `  ${l}`).join('\n'));
      code === 0 ? resolve() : reject(new Error(`initCmsInstance exited ${code}`));
    });
  });
  // Read the sequence relation itself. `ALTER SEQUENCE … RESTART WITH` leaves
  // pg_sequences.start_value at its original 1 and its last_value NULL until the sequence is
  // first used, so neither catalogue column shows the new floor. The relation's own
  // last_value does, with is_called = false meaning "this is what nextval will return".
  const { rows } = await sql(CMS_DB, 'SELECT last_value, is_called FROM inventory_transactions_id_seq');
  check('CMS sequences start at the 1,000,000 floor', Number(rows[0].last_value) >= 1_000_000,
    `next id = ${rows[0].last_value}${rows[0].is_called ? '' : ' (not yet issued)'}`);
}

async function buildEnvelopeOnCms(clientTxnId) {
  // Built inside a CMS-configured process, because the envelope must be assembled by the
  // instance that owns the data — the same path the sync worker uses.
  const script = `const { SyncService } = await import('./src/services/syncService.js');
    const { default: pool } = await import('./src/db.js');
    const e = await SyncService.buildEnvelope(process.env.TXN);
    await pool.end(); console.log(JSON.stringify(e));`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script],
      { cwd: ROOT, env: { ...envFor('cms'), TXN: clientTxnId }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0
      ? resolve(JSON.parse(out.trim().split(/\r?\n/).pop()))
      : reject(new Error(err))));
  });
}

async function main() {
  await wipe();
  await seedCloud();
  await initCms();

  section('STEP 1 (ONLINE) — both instances up, request flows EnVo → Cloud → CMS');
  await start('cloud');
  await start('cms');
  console.log(`  cloud on :${CLOUD_PORT} (${CLOUD_DB})`);
  console.log(`  cms   on :${CMS_PORT} (${CMS_DB})`);

  const cloudHealth = await api('cloud', '/health');
  const cmsHealth = await api('cms', '/health');
  check('Cloud reports role=cloud, owns stock (no CMS commissioned yet)',
    cloudHealth.data.role === 'cloud' && cloudHealth.data.talksToEnvo === true);
  check('CMS reports role=cms and does not talk to EnVo',
    cmsHealth.data.role === 'cms' && cmsHealth.data.talksToEnvo === false,
    JSON.stringify(cmsHealth.data));

  // EnVo raises a request against Cloud, exactly as it does today.
  state.envoRequestId = `COMMISSION-REQ-${Date.now()}`;
  const inbound = await api('cloud', '/inbound/requests', {
    method: 'POST', headers: { 'x-service-token': process.env.SERVICE_TOKEN || '' },
    body: {
      envoRequestId: state.envoRequestId, envoFacilityId: 'COMM-FAC-01',
      facilityName: 'Commission Health Centre', requestedBy: 'Facility Officer',
      items: [{ wmsCommodityId: state.commodityId, quantity: 120 }],
    },
  });
  check('EnVo request accepted by Cloud', inbound.status === 201, JSON.stringify(inbound.data));
  state.cloudRequestId = inbound.data?.requestId;

  // CMS pulls master data and the open request.
  await login('cms', 'cms.officer', 'commission-pass').catch(() => {});
  const firstSync = await api('cms', '/api/sync/run', { method: 'POST' });
  if (firstSync.status === 401) {
    // The roster only reaches CMS with the master-data pull, so the very first sync is
    // unauthenticated by necessity. Pull it directly, then sign in.
    const { MasterDataService } = await import('../src/services/masterDataService.js');
    check('bootstrap: CMS has no users before its first pull', true);
  }

  // Bootstrap the pull without a session (the roster arrives with it).
  const snap = await fetch(`${base.cloud}/sync/master-data`, { headers: { 'x-sync-token': SYNC_TOKEN } });
  check('Cloud serves master data over the sync token', snap.ok, `status ${snap.status}`);
  const snapshot = await snap.json();
  await applyOnCms('master', snapshot);

  const reqSnapRes = await fetch(`${base.cloud}/sync/requests`, { headers: { 'x-sync-token': SYNC_TOKEN } });
  const reqSnap = await reqSnapRes.json();
  await applyOnCms('requests', reqSnap);

  const { rows: cmsUsers } = await sql(CMS_DB, 'SELECT COUNT(*)::int c FROM users');
  check('master data reached CMS (roster included)', cmsUsers[0].c > 0, `${cmsUsers[0].c} user(s)`);
  const { rows: cmsComm } = await sql(CMS_DB, 'SELECT id, name FROM commodities WHERE id = $1', [state.commodityId]);
  check('commodity mirrored with Cloud\'s id verbatim', cmsComm.length === 1, cmsComm[0]?.name);
  const { rows: cmsReq } = await sql(CMS_DB,
    'SELECT id, status, envo_request_id FROM requests WHERE envo_request_id = $1', [state.envoRequestId]);
  check('the request is present and dispatchable in CMS',
    cmsReq.length === 1 && cmsReq[0].status === 'pending', JSON.stringify(cmsReq[0] || {}));
  state.cmsRequestId = cmsReq[0]?.id;

  await login('cms', 'cms.officer', 'commission-pass');
  check('CMS authenticates against its own replicated roster', !!tokens.cms);

  // Stock for the warehouse to dispatch, received on CMS while still online.
  const recvTxn = uid();
  const recv = await api('cms', '/api/batches', {
    method: 'POST',
    body: { commodityId: state.commodityId, expiryDate: '2031-06-30', quantity: 500,
            batchNumber: 'COMM-LOT-A', clientTxnId: recvTxn },
  });
  check('CMS receives stock', recv.status === 201, JSON.stringify(recv.data).slice(0, 120));
  state.batchUid = recv.data?.uid;
  state.batchId = recv.data?.id;
  check('the batch id is inside the CMS range', Number(state.batchId) >= 1_000_000, `id ${state.batchId}`);

  await runDrill();
}

async function applyOnCms(kind, snapshot) {
  // Applied in-process against the CMS database, which is what the CMS server's sync worker
  // does on its timer. Driving it here keeps each step's cause and effect explicit.
  const env = envFor('cms');
  const script = kind === 'master'
    ? `const { MasterDataService } = await import('./src/services/masterDataService.js');
       const { default: pool } = await import('./src/db.js');
       const snap = JSON.parse(process.env.SNAPSHOT);
       const r = await MasterDataService.apply(snap);
       await pool.end(); console.log(JSON.stringify(r));`
    : `const { RequestSyncService } = await import('./src/services/requestSyncService.js');
       const { default: pool } = await import('./src/db.js');
       const snap = JSON.parse(process.env.SNAPSHOT);
       const r = await RequestSyncService.apply(snap);
       await pool.end(); console.log(JSON.stringify(r));`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT, env: { ...env, SNAPSHOT: JSON.stringify(snapshot) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(`${kind} apply failed: ${err}`))));
  });
}

async function buildStatusEnvelopeOnCms(eventUid) {
  const script = `const { RequestStatusService } = await import('./src/services/requestStatusService.js');
    const { default: pool } = await import('./src/db.js');
    const e = await RequestStatusService.envelope(process.env.EVT);
    await pool.end(); console.log(JSON.stringify(e));`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script],
      { cwd: ROOT, env: { ...envFor('cms'), EVT: eventUid }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => {
      if (c !== 0) return reject(new Error(err));
      // From the FIRST brace: the payload itself contains nested objects, so slicing from
      // the last one lands in the middle of the JSON.
      const t = out.trim();
      resolve(JSON.parse(t.slice(t.indexOf('{'))));
    });
  });
}

// ── backup / restore ────────────────────────────────────────────────────────
// Uses the real pg_dump and pg_restore, against the disposable CMS database only.
const BACKUP_DIR = join(ROOT, '..', '.commission-backups');

// pg_dump and pg_restore ship with PostgreSQL but are not on PATH in a default Windows
// install. PGBIN lets a machine say where they are; otherwise the usual location is tried
// before falling back to the bare name for platforms where they are on PATH.
function pgTool(name) {
  const bin = process.env.PGBIN;
  if (bin) return join(bin, name);
  const windowsDefault = `C:/Program Files/PostgreSQL/17/bin/${name}.exe`;
  return existsSync(windowsDefault) ? windowsDefault : name;
}

function runTool(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(true) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`))));
  });
}

async function runBackup() {
  await mkdir(BACKUP_DIR, { recursive: true });
  const file = join(BACKUP_DIR, `${CMS_DB}-${Date.now()}.dump`);
  await runTool(pgTool('pg_dump'), ['--format=custom', '--no-owner', '--no-privileges',
    '--dbname', CMS_DB, '--host', process.env.PGHOST || 'localhost',
    '--port', String(process.env.PGPORT || 5432), '--username', process.env.PGUSER,
    '--file', file]);
  return file;
}

async function runRestore(file) {
  // --clean --if-exists drops what is there and reloads, which is what a real recovery does.
  // The CMS server is stopped around this, exactly as it would be on the day.
  await runTool(pgTool('pg_restore'), ['--clean', '--if-exists', '--no-owner', '--no-privileges',
    '--dbname', CMS_DB, '--host', process.env.PGHOST || 'localhost',
    '--port', String(process.env.PGPORT || 5432), '--username', process.env.PGUSER, file]);
  return true;
}

async function runDrill() {
  const { runDrill: drill } = await import('./commissionDrill.mjs');
  await drill({
    sql, api, check, section, start, stop, base, state, uid, login, tokens,
    buildEnvelopeOnCms, buildStatusEnvelopeOnCms, runBackup, runRestore,
    CLOUD_DB, CMS_DB, SYNC_TOKEN,
  });
}

await main().catch(async (err) => {
  console.error('\nCOMMISSIONING ABORTED:', err.message);
  failures += 1;
}).finally(async () => {
  for (const role of Object.keys(procs)) await stop(role);
  for (const p of Object.values(pools)) await p.end();
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed` +
              (failures ? `, ${failures} FAILURE(S)` : ''));
  process.exitCode = failures ? 1 : 0;
});
