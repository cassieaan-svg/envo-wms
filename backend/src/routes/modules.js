import express from 'express'
import { ModuleService } from '../services/moduleService.js'

const router = express.Router()

// Auth + scope are applied globally to /api (server.js). This route is not itself
// module-scoped — it reports which modules the caller may switch into.

/**
 * GET /api/modules - The modules the caller can work in, each with an `enrolled`
 * flag (facility users → their facility_modules; admin tiers → all). The client
 * shows every module and greys out the ones that aren't enrolled.
 */
router.get('/', async (req, res) => {
  try {
    const modules = await ModuleService.listForCaller(req.scope)
    res.json({ success: true, data: modules, count: modules.length, timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Error fetching modules:', err)
    res.status(500).json({ success: false, error: err.message, code: 'FETCH_ERROR' })
  }
})

export default router
