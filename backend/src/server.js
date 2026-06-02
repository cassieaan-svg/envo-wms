import dotenv from 'dotenv'
dotenv.config()

import express from 'express'
import cors from 'cors'

import stockRoutes from './routes/stock.js'
import transferRoutes from './routes/transfers.js'
import dispenseRoutes from './routes/dispense.js'
import intakeRoutes from './routes/intake.js'
import adjustmentRoutes from './routes/adjustments.js'
import reportRoutes from './routes/reports.js'

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

// API Routes
app.use('/api/stock', stockRoutes)
app.use('/api/transfers', transferRoutes)
app.use('/api/dispense', dispenseRoutes)
app.use('/api/intake', intakeRoutes)
app.use('/api/adjustments', adjustmentRoutes)
app.use('/api/reports', reportRoutes)

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

app.listen(PORT, () => {
  console.log(`🚀 Backend API running on http://localhost:${PORT}`)
  console.log(`📊 Health check: http://localhost:${PORT}/health`)
  console.log(`📚 Stock routes: http://localhost:${PORT}/api/stock`)
})
