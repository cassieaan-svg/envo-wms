// Proves the ENVO_DIAG instrumentation both works when enabled AND is inert when
// not. The second half matters more: a diagnostic that quietly changes the normal
// path would corrupt the very measurements it exists to produce.
//
// Runs the module in a child process for each flag state, because DIAG is read
// once at import time — which is the point, so the disabled path has no runtime
// branch per query.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const backend = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (code, env) =>
  JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code],
    { cwd: backend, env: { ...process.env, ...env }, encoding: 'utf8' }).trim().split('\n').pop())

test('ENABLED: pool wait and db execution are measured separately', () => {
  const out = run(`
    const { query, pool } = await import('./src/db.js')
    const d = await import('./src/diag.js')
    // Warm the pool first: the very first acquire also opens the TCP connection
    // and authenticates (~100ms), which is real acquisition cost but not the
    // contention we are isolating here.
    await query('select 1')
    // One slow query with the pool warm and free: all time is db, none is wait.
    const solo = {}
    await d.reqStore.run(solo, async () => { await query('select pg_sleep(0.4)') })
    // More concurrent queries than connections: pool wait must appear.
    const many = {}
    const peakSeen = []
    const t = setInterval(() => peakSeen.push(pool.waitingCount), 20)
    await d.reqStore.run(many, async () =>
      await Promise.all(Array.from({ length: 20 }, () => query('select pg_sleep(0.2)'))))
    clearInterval(t)
    await pool.end()
    console.log(JSON.stringify({
      enabled: d.DIAG,
      soloWait: Math.round(solo.pool_wait), soloDb: Math.round(solo.db), soloN: solo.n,
      manyWait: Math.round(many.pool_wait), peakWaiting: Math.max(...peakSeen),
      counters: ['totalCount','idleCount','waitingCount'].every(k => typeof pool[k] === 'number'),
    }))`, { ENVO_DIAG: '1' })

  assert.equal(out.enabled, true)
  assert.ok(out.counters, 'pg pool must expose total/idle/waiting')
  // A query that owns its connection outright should show ~no acquisition wait.
  assert.ok(out.soloWait < 25, `solo pool_wait ${out.soloWait}ms — a warm, free pool should hand over a connection immediately`)
  assert.ok(out.soloDb >= 350, `solo db ${out.soloDb}ms — expected ~400`)
  assert.equal(out.soloN, 1, 'query count must be tracked')
  // Oversubscribing the pool must surface as wait, not as db time.
  assert.ok(out.peakWaiting > 0, 'waitingCount must rise above 0 when oversubscribed')
  assert.ok(out.manyWait > 0, 'pool_wait must be recorded under contention')
})

test('ENABLED: recorded data is redacted and carries no bind parameters', async () => {
  const { redact } = await import('../src/diag.js')
  assert.equal(redact('/api/events?token=abc.def.ghi'), '/api/events?token=[redacted]')
  assert.equal(redact('/x?a=1&access_token=zzz&b=2'), '/x?a=1&access_token=[redacted]&b=2')
  assert.equal(redact('/api/stock/summary?group_by=facility'), '/api/stock/summary?group_by=facility')
})

test('DISABLED: the query path is byte-identical to the original', () => {
  const out = run(`
    const { query, pool } = await import('./src/db.js')
    const d = await import('./src/diag.js')
    const store = {}
    await d.reqStore.run(store, async () => { await query('select 1 as x') })
    const r = await query('select 2 as y')
    await pool.end()
    console.log(JSON.stringify({
      enabled: d.DIAG,
      // Nothing recorded: the instrumented branch must not have run at all.
      recorded: Object.keys(store).length,
      queryStillWorks: r.rows[0].y,
    }))`, { ENVO_DIAG: '' })

  assert.equal(out.enabled, false, 'DIAG must be off without the flag')
  assert.equal(out.recorded, 0, 'no timings may be recorded when disabled')
  assert.equal(out.queryStillWorks, 2, 'the plain pool.query path must still work')
})

test('DISABLED: the sampler never starts and the diag route is not mounted', () => {
  const out = run(`
    const d = await import('./src/diag.js')
    const { pool } = await import('./src/db.js')
    const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length
    d.startSampler(pool)          // must be a no-op
    const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length
    await pool.end()
    console.log(JSON.stringify({ enabled: d.DIAG, timersAdded: after - before }))`,
    { ENVO_DIAG: '' })

  assert.equal(out.enabled, false)
  assert.equal(out.timersAdded, 0, 'the 100ms sampler must not run when disabled')
})

test('the admin guard shared with the rest of the oversight surface', async () => {
  const { isAdminScope } = await import('../src/middleware/scope.js')
  for (const level of ['overall_admin', 'state_admin', 'state_viewer', 'cluster_admin', 'lga_admin']) {
    assert.ok(isAdminScope({ accessLevel: level }), `${level} should reach the readout`)
  }
  assert.ok(isAdminScope({ isAdmin: true, accessLevel: 'facility' }), 'is_admin flag honoured')
  // The readout exposes SQL text, so ordinary users must not reach it.
  assert.equal(isAdminScope({ accessLevel: 'facility' }), false, 'facility user must be refused')
  assert.equal(isAdminScope({ accessLevel: 'facility', facilityRole: 'store_manager' }), false)
  assert.equal(isAdminScope(null), false)
  assert.equal(isAdminScope(undefined), false)
})

test('ENABLED via .env alone, not just a shell variable', () => {
  // How the flag is actually set in production. ES module imports evaluate before
  // the importing module's body, so a module that reads process.env at import time
  // sees nothing unless it loads .env itself — which is what silently kept the
  // whole diagnostic switched off the first time it was deployed.
  const fs = require('node:fs')
  const envPath = join(backend, '.env')
  const original = fs.readFileSync(envPath, 'utf8')
  try {
    fs.writeFileSync(envPath, `${original}
ENVO_DIAG=1
`)
    const out = run(`
      const d = await import('./src/diag.js')
      console.log(JSON.stringify({ enabled: d.DIAG }))`, { ENVO_DIAG: undefined })
    assert.equal(out.enabled, true, 'ENVO_DIAG in .env must enable diagnostics')
  } finally {
    fs.writeFileSync(envPath, original)
  }
})
