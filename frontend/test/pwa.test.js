// Phase 6 — PWA configuration, CMS server resolution, and connection wording.
//
// Deliberately no browser and no component renderer. The things worth guarding here are
// decisions, not pixels: where the app points, what it caches, and what it tells a
// storekeeper when something is wrong. All three are pure functions or build output, so they
// can be checked directly — a DOM harness would add a dependency and test less.
//
//   npm test --workspace @envo/wms-frontend
//
// The build-output tests require `npm run build` to have been run first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const readDist = (f) => readFile(join(DIST, f), 'utf8');
const exists = async (f) => access(join(DIST, f)).then(() => true, () => false);

// ── A stand-in for localStorage, so cmsServer.js can be exercised under node ──
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}
globalThis.localStorage = fakeStorage();
globalThis.location = { origin: 'http://192.168.1.20:5100' };

const cms = await import('../src/lib/cmsServer.js');
const { classifyConnection, STATE } = await import('../src/lib/connection.js');

// ── Manifest ────────────────────────────────────────────────────────────────
test('the manifest describes an installable warehouse application', async (t) => {
  if (!(await exists('manifest.webmanifest'))) return t.skip('run `npm run build` first');
  const m = JSON.parse(await readDist('manifest.webmanifest'));

  assert.match(m.name, /Central Medical Store/i, 'names the warehouse, not just the product');
  assert.equal(m.short_name, 'CMS Warehouse');
  assert.equal(m.display, 'standalone', 'opens in its own window, not a browser tab');
  assert.equal(m.start_url, '/');
  assert.ok(m.theme_color && m.background_color, 'has theme and background colours');

  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), 'has the 192px icon installers require');
  assert.ok(sizes.includes('512x512'), 'has the 512px icon installers require');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'),
    'has a maskable icon, so a platform that crops to a circle does not cut into the mark');
});

test('the icons are real PNGs of the size they claim', async (t) => {
  if (!(await exists('icon-192.png'))) return t.skip('run `npm run build` first');
  for (const [file, expected] of [['icon-192.png', 192], ['icon-512.png', 512],
                                  ['icon-maskable-512.png', 512]]) {
    const b = await readFile(join(DIST, file));
    assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is a PNG`);
    assert.equal(b.readUInt32BE(16), expected, `${file} is ${expected}px wide`);
    assert.equal(b.readUInt32BE(20), expected, `${file} is ${expected}px tall`);
  }
});

// ── Service worker ──────────────────────────────────────────────────────────
test('the service worker caches the shell and NEVER warehouse data', async (t) => {
  if (!(await exists('sw.js'))) return t.skip('run `npm run build` first');
  const sw = await readDist('sw.js');

  const manifest = sw.match(/\[\{[^\]]*\}\]/);
  assert.ok(manifest, 'the precache manifest is present');
  const urls = [...manifest[0].matchAll(/url:"([^"]+)"/g)].map((m) => m[1]);

  assert.ok(urls.includes('index.html'), 'the shell is precached, so the app opens offline');
  assert.ok(urls.some((u) => u.endsWith('.js')), 'application code is precached');
  assert.ok(urls.some((u) => u.endsWith('.css')), 'styles are precached');

  // THE ONE THAT MATTERS. A cached stock figure would let a picker dispatch against a
  // quantity that no longer exists.
  const cachedApi = urls.filter((u) => /^\/?(api|health|sync|inbound)\b/.test(u));
  assert.deepEqual(cachedApi, [],
    'no API response may be precached — warehouse data comes from the server or not at all');

  assert.match(sw, /NetworkOnly/, 'API routes are declared NetworkOnly at runtime');
});

// ── Where the app points ────────────────────────────────────────────────────
test('the CMS address is resolved at runtime, and never defaults to localhost', () => {
  localStorage.clear();

  // Nothing configured: same origin, which is right when the CMS server serves the app.
  assert.equal(cms.getServerBase(), '', 'falls back to same origin');
  assert.equal(cms.describeServer().source, 'same-origin');

  // A device pointed at the store server by hand.
  cms.setConfiguredServer('192.168.1.20:5100');
  assert.equal(cms.getServerBase(), 'http://192.168.1.20:5100', 'scheme is added');
  assert.equal(cms.describeServer().source, 'device');

  cms.clearConfiguredServer();
  assert.equal(cms.getServerBase(), '');

  // localhost is never a default. On a tablet it is the tablet, and a wrong default fails
  // in a way that looks like the server is down.
  assert.ok(!cms.getServerBase().includes('localhost'));
});

test('addresses people actually type are accepted', () => {
  assert.equal(cms.normaliseServerUrl('192.168.1.20:5100/'), 'http://192.168.1.20:5100');
  assert.equal(cms.normaliseServerUrl('http://cms.local:5100/api'), 'http://cms.local:5100',
    'a pasted /api is stripped rather than doubled');
  assert.equal(cms.normaliseServerUrl('  https://cms.example:5100  '), 'https://cms.example:5100');
  assert.equal(cms.normaliseServerUrl(''), '');

  assert.ok(cms.isValidServerUrl('192.168.1.20:5100'));
  assert.ok(!cms.isValidServerUrl(''));
  assert.ok(!cms.isValidServerUrl('   '));
});

// ── What the warehouse is told ──────────────────────────────────────────────
test('CMS unreachable is stated plainly, and blocks work', () => {
  const c = classifyConnection({ serverUp: false, error: 'no answer from the server' });
  assert.equal(c.state, STATE.UNAVAILABLE);
  assert.equal(c.canWork, false);
  assert.match(c.short, /Warehouse server unavailable/i);
  assert.match(c.detail, /CMS server is running/i, 'says what to check');
  assert.match(c.detail, /no stock has been lost/i, 'and that nothing was lost');
});

test('Cloud unavailable is normal: work continues and the wording reassures', () => {
  const c = classifyConnection({
    serverUp: true, sync: { pendingTransactions: 3, pendingStatusEvents: 2 },
  });
  assert.equal(c.state, STATE.HOLDING);
  assert.equal(c.canWork, true, 'Cloud being away must never stop the warehouse');
  assert.equal(c.held, 5);
  assert.match(c.detail, /3 transactions and 2 status updates/);
  assert.match(c.detail, /Carry on as usual/i);
  assert.ok(!/error|fail|problem/i.test(c.detail), 'not worded as a fault, because it is not one');
});

test('connected and up to date says nothing alarming', () => {
  const c = classifyConnection({ serverUp: true, sync: { pendingTransactions: 0 } });
  assert.equal(c.state, STATE.CONNECTED);
  assert.equal(c.canWork, true);
  assert.equal(c.held, 0);
});

test('singular and plural read correctly', () => {
  const one = classifyConnection({ serverUp: true, sync: { pendingTransactions: 1 } });
  assert.match(one.detail, /1 transaction recorded/);
  assert.ok(!/1 transactions/.test(one.detail));
});

// ── The API client's failure mode ───────────────────────────────────────────
test('a request that reaches no server is reported as the server being unavailable', async () => {
  localStorage.clear();
  cms.setConfiguredServer('http://127.0.0.1:59999');   // nothing listens here
  const { api } = await import('../src/lib/api.js');
  try {
    await api.sync.status();
    assert.fail('should not have succeeded');
  } catch (err) {
    assert.equal(err.offline, true, 'flagged as unreachable, not as a normal error');
    assert.match(err.message, /Warehouse server unavailable/);
  } finally {
    cms.clearConfiguredServer();
  }
});
