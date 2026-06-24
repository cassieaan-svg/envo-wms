import dotenv from 'dotenv'
dotenv.config()

import express from 'express'
import cors from 'cors'

import { authMiddleware } from './middleware/auth.js'
import { attachScope } from './middleware/scope.js'
import { initRealtime, sseHandler } from './realtime.js'

import authRoutes from './routes/auth.js'
import stockRoutes from './routes/stock.js'
import transferRoutes from './routes/transfers.js'
import dispenseRoutes from './routes/dispense.js'
import intakeRoutes from './routes/intake.js'
import adjustmentRoutes from './routes/adjustments.js'
import reportRoutes from './routes/reports.js'
import facilityRoutes from './routes/facilities.js'
import commodityRoutes from './routes/commodities.js'
import amcSettingsRoutes from './routes/amcSettings.js'
import editHistoryRoutes from './routes/editHistory.js'

const app = express()
const PORT = process.env.PORT || 5000

// Middleware
app.use(cors())
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

app.use('/api/stock', stockRoutes)
app.use('/api/transfers', transferRoutes)
app.use('/api/dispense', dispenseRoutes)
app.use('/api/intake', intakeRoutes)
app.use('/api/adjustments', adjustmentRoutes)
app.use('/api/reports', reportRoutes)
app.use('/api/facilities', facilityRoutes)
app.use('/api/commodities', commodityRoutes)
app.use('/api/amc-settings', amcSettingsRoutes)
app.use('/api/edit-history', editHistoryRoutes)

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
