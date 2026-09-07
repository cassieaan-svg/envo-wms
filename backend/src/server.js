import dotenv from 'dotenv'
dotenv.config()

import express from 'express'
import cors from 'cors'
import compression from 'compression'

import { authMiddleware } from './middleware/auth.js'
import { attachScope, isAdminScope } from './middleware/scope.js'
import { initRealtime, sseHandler } from './realtime.js'
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

// Request-boundary timing (Server-Timing header). Registered ONLY when
// ENVO_DIAG=1, so the default path carries no extra middleware at all.
if (DIAG) {
  app.use(diagMiddleware(pool))
  startSampler(pool)
}

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

// Realtime SSE stream. Registered BEFORE the /api auth middleware because
// EventSource can't send an Authorization header — sseHandler verifies ?token= itself.
app.get('/api/events', sseHandler)

// Gate the entire data surface. authMiddleware verifies the bearer token and sets
// req.user; attachScope normalizes user_metadata into req.scope. Both run before any
// /api route handler, so individual routes can assume req.user / req.scope exist.
app.use('/api', authMiddleware, attachScope)

// Pool readout. The route does not exist unless ENVO_DIAG=1 — it is never
// mounted, so it 404s like any unknown path rather than advertising itself. When
// mounted it is still admin-only, via the same isAdminScope guard the rest of the
// oversight surface uses. It exposes SQL text (never bind parameters), so it must
// not be reachable by an ordinary facility user.
if (DIAG) {
  app.get('/api/_diag/pool', (req, res) => {
    if (!isAdminScope(req.scope)) {
      return res.status(403).json({ success: false, error: 'Forbidden', code: 'FORBIDDEN' })
    }
    return diagHandler(pool)(req, res)
  })
}

app.use('/api/stock', stockRoutes)
app.use('/api/transfers', transferRoutes)
app.use('/api/dispense', dispenseRoutes)
app.use('/api/intake', intakeRoutes)
app.use('/api/adjustments', adjustmentRoutes)
app.use('/api/activity', activityRoutes)
app.use('/api/reports', reportRoutes)
app.use('/api/facilities', facilityRoutes)
app.use('/api/commodities', commodityRoutes)
app.use('/api/amc-settings', amcSettingsRoutes)
app.use('/api/edit-history', editHistoryRoutes)
app.use('/api/bincard', binCardRoutes)
// ACL configuration screens. Every handler gates on req.scope (system_admin or
// state_admin); the ACL resolver is not imported here and stays shadow-only.
app.use('/api/admin', adminRoutes)

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

app.listen(PORT, () => {
  console.log(`🚀 Backend API running on http://localhost:${PORT}`)
  console.log(`📊 Health check: http://localhost:${PORT}/health`)
  console.log(`📚 Stock routes: http://localhost:${PORT}/api/stock`)
})
