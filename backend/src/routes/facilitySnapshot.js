import express from 'express'
import crypto from 'node:crypto'
import { enforceModuleAccess, sectionFilter } from '../middleware/scope.js'
import { CommodityService } from '../services/commodityService.js'
import { StockService } from '../services/stockService.js'
import { FacilityService } from '../services/facilityService.js'

const router = express.Router()

// GET /api/facility-snapshot — everything an offline-capable facility device needs
// cached in one pull: the catalogue (with prices), this facility's current stock, and
// the facility record itself. Mirrors envo-wms's MasterDataService.snapshot() — same
// generatedAt/version/counts/data envelope — but scoped to ONE facility rather than
// the whole system, since that's the unit a device actually needs (see
// docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms sibling project).
//
// No KB articles yet — that's the separate, not-yet-built facility-enquiry design.
//
// Deliberately facility-tier only: this is "what does MY device cache", not an admin
// export. An admin wanting the full catalogue already has GET /api/commodities?all=true.
router.get('/', async (req, res) => {
  try {
    if (req.scope.module !== 'essential') {
      return res.status(400).json({
        success: false, error: 'The facility snapshot belongs to the Essential Commodities module', code: 'WRONG_MODULE',
      })
    }
    if (!(await enforceModuleAccess(req, res))) return

    if (req.scope.accessLevel !== 'facility' || !req.scope.facilityId) {
      return res.status(403).json({
        success: false, error: 'A facility login is required to pull a facility snapshot', code: 'FORBIDDEN',
      })
    }
    const facilityId = req.scope.facilityId

    const { categories, commodityNames } = sectionFilter(req)
    const [facility, commodities, stock] = await Promise.all([
      FacilityService.getFacilityById(facilityId),
      CommodityService.getCommodities({
        module: 'essential', activeOnly: true,
        scopeCategories: categories, scopeCommodityNames: commodityNames,
      }),
      StockService.getStock(facilityId, { categories, commodityNames, limit: 10000 }),
    ])

    if (!facility) {
      return res.status(404).json({ success: false, error: 'Facility not found', code: 'FACILITY_NOT_FOUND' })
    }

    const payload = {
      facility: { id: facility.id, name: facility.name, code: facility.code, state: facility.state, lga: facility.lga },
      commodities,
      stock,
    }

    res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      // A cheap way for the device to tell "did anything change since my last pull"
      // without diffing the payload itself.
      version: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      counts: { commodities: commodities.length, stock: stock.length },
      data: payload,
    })
  } catch (err) {
    console.error('Error building facility snapshot:', err)
    res.status(500).json({ success: false, error: err.message, code: 'SNAPSHOT_ERROR' })
  }
})

export default router
