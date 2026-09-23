import dotenv from 'dotenv'
dotenv.config()

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import compression from 'compression'

import { authMiddleware } from './middleware/auth.js'
import { attachScope } from './middleware/scope.js'
import { serviceAuth } from './middleware/serviceAuth.js'
import { initRealtime, sseHandler } from './realtime.js'
import { startOutboxWorker } from './lib/outboxWorker.js'
import { DIAG, diagMiddleware, diagHandler, startSampler } from './diag.js'
import { pool } from './db.js'

import authRoutes from './routes/auth.js'
import stockRoutes from './routes/stock.js'
import transferRoutes from './routes/transfers.js'
import dispenseRoutes from './routes/dispense.js'
import intakeRoutes from './routes/intake.js'
import adjustmentRoutes from './routes/adjustments.js'
import activityRoutes from './routes/activity.js'
import reportRoutes from './routes/reports.js'
import facilityRoutes from './routes/facilities.js'
import commodityRoutes from './routes/commodities.js'
import amcSettingsRoutes from './routes/amcSettings.js'
import editHistoryRoutes from './routes/editHistory.js'
import binCardRoutes from './routes/bincard.js'
import moduleRoutes from './routes/modules.js'
import schemeRoutes from './routes/schemes.js'
import warehouseRequestRoutes from './routes/warehouseRequests.js'
import facilitySnapshotRoutes from './routes/facilitySnapshot.js'
import warehouseRequestHooks from './routes/warehouseRequestHooks.js'
import facilityStockHooks from './routes/facilityStockHooks.js'
import commodityPriceHooks from './routes/commodityPriceHooks.js'
import adminRoutes from './routes/admin.js'

const app = express()
const PORT = process.env.PORT || 5000

// Middleware
app.use(cors())

// Compress every API response above 1 KB. The JSON here is highly repetitive, so
// this is the difference between a multi-second transfer and a fast one on a
// field connection. Measured on the 5,716 KB stock payload:
//
//   Accept-Encoding: br, gzip  ->  br    449 KB   297 ms   (12.7x)
//   Accept-Encoding: gzip      ->  gzip  752 KB   250 ms    (7.6x)
//   Accept-Encoding: identity  ->        5716 KB  174 ms
//
// compression@1.8 negotiates Brotli when the client offers it (every current
// browser does) and falls back to gzip otherwise — so production serves `br`.
// Its Brotli default is QUALITY 4, not the zlib default of 11; that matters,
// because 11 on a payload this size would cost seconds of CPU in a
// single-threaded process. Do not raise it without measuring.
//
// The 1 KB threshold keeps small responses (the /stock/summary rollup is ~17 KB,
// the dispense aggregates a few KB) from paying setup cost for nothing.
//
// The SSE stream MUST be excluded explicitly. compression's default filter falls
// back to a `^text/` match, which accepts text/event-stream — it would then buffer
// the stream and realtime events would stop arriving until the buffer flushed.
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if ((res.getHeader('Content-Type') || '').toString().includes('text/event-stream')) return false
    return compression.filter(req, res)
  },
}))

// Request-boundary timing (Server-Timing header). No-op unless ENVO_DIAG=1.
app.use(diagMiddleware(pool))
startSampler(pool)

app.use(express.json())

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'Backend API is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  })
})

// Auth routes are public (login) or self-guarded (/me, /password apply authMiddleware
// per-route). Everything under /api/* requires a valid JWT and a derived scope.
app.use('/auth', authRoutes)

// Server-to-server status callback from the WMS. Service-token auth, registered before
// the /api user-JWT layer since it isn't a user login.
app.use('/hooks/warehouse-requests', serviceAuth, warehouseRequestHooks)
app.use('/hooks/facilities', serviceAuth, facilityStockHooks)
app.use('/hooks/commodities', serviceAuth, commodityPriceHooks)

// Realtime SSE stream. Registered BEFORE the /api auth middleware because
// EventSource can't send an Authorization header — sseHandler verifies ?token= itself.
app.get('/api/events', sseHandler)

// Gate the entire data surface. authMiddleware verifies the bearer token and sets
// req.user; attachScope normalizes user_metadata into req.scope. Both run before any
// /api route handler, so individual routes can assume req.user / req.scope exist.
app.use('/api', authMiddleware, attachScope)

// Dev-only pool readout. Admin-gated, and 404s entirely unless ENVO_DIAG=1 so it
// cannot be probed in normal operation.
app.get('/api/_diag/pool', (req, res, next) => {
  if (!DIAG) return next()
  if (!['overall_admin', 'state_admin', 'lga_admin'].includes(req.scope?.accessLevel)) {
    return res.status(403).json({ success: false, error: 'Forbidden', code: 'FORBIDDEN' })
  }
  return diagHandler(pool)(req, res)
})

app.use('/api/stock', stockRoutes)
app.use('/api/transfers', transferRoutes)
app.use('/api/dispense', dispenseRoutes)
app.use('/api/intake', intakeRoutes)
app.use('/api/adjustments', adjustmentRoutes)
app.use('/api/activity', activityRoutes)
app.use('/api/reports', reportRoutes)
app.use('/api/facilities', facilityRoutes)
app.use('/api/commodities', commodityRoutes)
app.use('/api/modules', moduleRoutes)
app.use('/api/schemes', schemeRoutes)
app.use('/api/warehouse-requests', warehouseRequestRoutes)
app.use('/api/facility-snapshot', facilitySnapshotRoutes)
app.use('/api/amc-settings', amcSettingsRoutes)
app.use('/api/edit-history', editHistoryRoutes)
app.use('/api/bincard', binCardRoutes)
// ACL configuration screens. Every handler gates on req.scope (system_admin or
// state_admin); the ACL resolver is not imported here and stays shadow-only.
app.use('/api/admin', adminRoutes)

// Serve the built frontend from the same origin as the API (single Render Web Service).
// Mounted AFTER every API route so it can never shadow /api, /auth, /hooks or /health.
// Skipped when there is no build, so a dev machine running `vite` separately is unaffected.
// The frontend builds to the repo-root /dist (vite.config.js build.outDir).
const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')

if (existsSync(join(distDir, 'index.html'))) {
  app.use(express.static(distDir, {
    // index.html and the service worker must never be cached, or a device keeps running
    // an old build after a deploy; hashed assets can be cached hard.
    setHeaders(res, filePath) {
      if (/(index\.html|sw\.js|manifest\.webmanifest|registerSW\.js)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache')
      } else if (/[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      }
    },
  }))

  // Any other GET that isn't an API/backend path is the SPA being opened at some route.
  // GET only, so a mistyped POST still 404s instead of returning a page.
  app.get(/^\/(?!api|auth|hooks|health).*/, (req, res, next) => {
    if (req.accepts('html')) return res.sendFile(join(distDir, 'index.html'))
    return next()
  })
} else {
  console.log('[web] no frontend build found at', distDir, '— serving the API only')
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    code: 'NOT_FOUND'
  })
})

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_ERROR'
  })
})

initRealtime()
startOutboxWorker()

app.listen(PORT, () => {
  console.log(`🚀 Backend API running on http://localhost:${PORT}`)
  console.log(`📊 Health check: http://localhost:${PORT}/health`)
  console.log(`📚 Stock routes: http://localhost:${PORT}/api/stock`)
})
