// Measures the dashboard's data cost against a running EnVo backend, so the
// Phase 1-3 optimisation can be validated on PRODUCTION with the same method used
// locally (rather than trusting local numbers to carry over).
//
// Reports, for the token's scope: request count, true on-the-wire bytes (gzip and
// identity, measured separately — fetch() auto-decompresses and would understate
// nothing but hide the gzip ratio), per-request latency, and the number of records
// shipped to the browser.
//
// Usage:
//   ENVO_URL=https://envo.example.ng ENVO_TOKEN=<jwt> node scripts/measureDashboard.mjs
//   # optional: --before  also measures the pre-optimisation request set for comparison
//
// Get a token by logging into the app and copying localStorage['envo_token'].
// The script only issues GETs — it never writes.

import http from 'node:http'
import https from 'node:https'

const BASE = process.env.ENVO_URL || 'http://localhost:5000'
const TOKEN = process.env.ENVO_TOKEN
const ALSO_BEFORE = process.argv.includes('--before')

if (!TOKEN) {
  console.error('ENVO_TOKEN is required (localStorage["envo_token"] from a logged-in session).')
  process.exit(1)
}

const url = new URL(BASE)
const client = url.protocol === 'https:' ? https : http

// One request, counting RAW bytes off the socket (no auto-decompression).
function fetchRaw(path, gzip) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const req = client.request({
      protocol: url.protocol, host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: (url.pathname === '/' ? '' : url.pathname) + path,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Accept-Encoding': gzip ? 'gzip' : 'identity',
      },
    }, res => {
      const chunks = []
      let bytes = 0
      res.on('data', c => { chunks.push(c); bytes += c.length })
      res.on('end', () => resolve({
        status: res.statusCode, bytes, ms: Date.now() - started,
        encoding: res.headers['content-encoding'] || 'identity',
        body: gzip ? null : Buffer.concat(chunks).toString(),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function measure(label, path) {
  const identity = await fetchRaw(path, false)
  const gzipped = await fetchRaw(path, true)
  let rows = '-'
  if (identity.status === 200) {
    try {
      const parsed = JSON.parse(identity.body)
      const data = parsed.data ?? parsed
      if (Array.isArray(data)) rows = data.length
    } catch { /* non-JSON body — leave rows unknown */ }
  }
  return {
    label, status: identity.status, rows,
    identityKB: +(identity.bytes / 1024).toFixed(1),
    gzipKB: +(gzipped.bytes / 1024).toFixed(1),
    ms: gzipped.ms,
    encoded: gzipped.encoding,
  }
}

const total = (rows, key) => +rows.reduce((s, r) => s + r[key], 0).toFixed(1)

// ── Commodity ids, needed for the AMC window request ────────────────────────
const commoditiesRes = await fetchRaw('/api/commodities', false)
if (commoditiesRes.status !== 200) {
  console.error(`GET /api/commodities returned ${commoditiesRes.status} — check ENVO_URL and ENVO_TOKEN.`)
  process.exit(1)
}
const commodityIds = JSON.parse(commoditiesRes.body).data.map(c => c.id)
const to = new Date().toISOString()
const from = new Date(Date.now() - 90 * 86400000).toISOString()
const amcPath = `/api/dispense/summary?commodity_ids=${commodityIds.join(',')}&from=${from}&to=${to}`

// ── AFTER: what the migrated dashboard actually requests ────────────────────
const after = [
  await measure('stock/summary  [critical]', '/api/stock/summary'),
  await measure('dispense/summary  [critical]', amcPath),
  await measure('commodities/transacted  [lazy]', '/api/commodities/transacted'),
]
console.log('\n=== AFTER — dashboard requests ===')
console.table(after)
const critical = after.filter(r => r.label.includes('[critical]'))
console.log('requests:', after.length, '(critical:', critical.length + ')')
console.log('bytes  identity:', total(after, 'identityKB'), 'KB | gzip:', total(after, 'gzipKB'), 'KB')
console.log('records shipped to browser:', after[0].rows)
console.log('gzip active:', after.every(r => r.encoded === 'gzip' || r.identityKB < 1) ? 'yes' : 'NO — check compression middleware')

// ── App-wide prefetch still present until Phase 6 ───────────────────────────
const prefetch = await measure('stock?limit=50000  [App.jsx prefetch]', '/api/stock?limit=50000&offset=0')
console.log('\n=== Still present until Phase 6 (useRealtimeStock) ===')
console.table([prefetch])

if (ALSO_BEFORE) {
  // The pre-optimisation request set, for a like-for-like comparison. Safe to run:
  // these endpoints still exist and are read-only.
  const before = [
    await measure('stock dump', '/api/stock?limit=50000&offset=0'),
    await measure('dsd p1', '/api/stock/dsd?limit=1000&offset=0'),
    await measure('sdp p1', '/api/stock/sdp?limit=1000&offset=0'),
    await measure('sdp p2', '/api/stock/sdp?limit=1000&offset=1000'),
    await measure('sdp p3', '/api/stock/sdp?limit=1000&offset=2000'),
    await measure('dispense/summary', amcPath),
    await measure('commodities/transacted', '/api/commodities/transacted'),
  ]
  console.log('\n=== BEFORE — the request set the dashboard used to issue ===')
  console.table(before)
  console.log('requests:', before.length)
  console.log('bytes  identity:', total(before, 'identityKB'), 'KB | gzip:', total(before, 'gzipKB'), 'KB')
  const records = before.filter(r => typeof r.rows === 'number' && !r.label.startsWith('dispense') && !r.label.startsWith('commodities'))
  console.log('records shipped to browser:', records.reduce((s, r) => s + r.rows, 0))

  console.log('\n=== BEFORE vs AFTER (dashboard requests) ===')
  console.table([{
    metric: 'requests', before: before.length, after: after.length,
  }, {
    metric: 'identity KB', before: total(before, 'identityKB'), after: total(after, 'identityKB'),
  }, {
    metric: 'gzip KB', before: total(before, 'gzipKB'), after: total(after, 'gzipKB'),
  }, {
    metric: 'largest response KB (identity)',
    before: Math.max(...before.map(r => r.identityKB)),
    after: Math.max(...after.map(r => r.identityKB)),
  }, {
    metric: 'slowest request ms',
    before: Math.max(...before.map(r => r.ms)),
    after: Math.max(...after.map(r => r.ms)),
  }])
}
