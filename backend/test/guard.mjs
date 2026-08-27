// Refuses to let the test suite touch anything but a scratch database.
//
// The tests write, and they delete. They create commodities, dispatch real quantities out
// of real batches, and tear the rows down again. Pointed at the warehouse database — one
// stale PGDATABASE in a shell, one .env copied from the VM — that is not a failing test
// run, it is stock destroyed with no movement to explain it.
//
// Loaded with `node --import` BEFORE any test module (see the `test` script in
// package.json), and again from test/helpers.js, so a new test file that forgets to import
// the helpers is still covered. It throws rather than exits: a thrown error at import time
// stops the run and prints the reason.
//
// To run the tests, point them at a scratch database:
//
//   createdb envo_wms_test
//   PGDATABASE=envo_wms_test npm run migrate
//   PGDATABASE=envo_wms_test npm test
//
// The name must end in `_test`, or be named explicitly in WMS_TEST_DATABASE. There is no
// flag that disables this check, because the one time it matters is the time someone is in
// a hurry.

// Load .env exactly as src/db.js does, so this checks the connection the tests would
// ACTUALLY open — not just what happens to be exported in the shell. dotenv never overrides
// a variable already set, so an explicit `PGDATABASE=… npm test` still wins over the file,
// while a .env quietly pointing at the warehouse is caught rather than ignored.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const database = (process.env.PGDATABASE || '').trim();
const host = (process.env.PGHOST || 'localhost').trim().toLowerCase();
const named = (process.env.WMS_TEST_DATABASE || '').trim();

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

function refuse(reason, detail) {
  throw new Error(
    [
      '',
      '  ┌─ TEST SUITE REFUSED TO RUN ─────────────────────────────────────────',
      `  │ ${reason}`,
      `  │ ${detail}`,
      '  │',
      '  │ These tests write to and delete from the database they are given.',
      '  │ Point them at a scratch database, never the warehouse:',
      '  │',
      '  │   createdb envo_wms_test',
      '  │   PGDATABASE=envo_wms_test npm run migrate',
      '  │   PGDATABASE=envo_wms_test npm test',
      '  └─────────────────────────────────────────────────────────────────────',
      '',
    ].join('\n')
  );
}

if (!database) {
  refuse('No PGDATABASE is set.', 'The suite will not fall back to a default database.');
}

const allowedByName = named ? database === named : /_test$/.test(database);

if (!allowedByName) {
  refuse(
    `PGDATABASE is "${database}", which is not a test database.`,
    named
      ? `WMS_TEST_DATABASE names "${named}"; only that database is allowed.`
      : 'The name must end in "_test", or be named in WMS_TEST_DATABASE.'
  );
}

// A test database on another machine is a contradiction, and the most likely explanation is
// a .env pointing at the VM. Deliberately overridable — a shared CI Postgres is legitimate —
// but never by accident.
if (!LOCAL_HOSTS.has(host) && process.env.WMS_TEST_ALLOW_REMOTE !== '1') {
  refuse(
    `PGHOST is "${host}", which is not this machine.`,
    'Set WMS_TEST_ALLOW_REMOTE=1 only if that host is genuinely a disposable test server.',
  );
}
