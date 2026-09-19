import { useEffect } from 'react'
import { useAppStore } from '../store/appStore'
import { startAutoSync, stopAutoSync } from '../lib/snapshotSync'
import { startDrainLoop, stopDrainLoop } from '../lib/offlineQueue'
import { OfflineStatusBar } from './OfflineStatusBar'

// Starts the background snapshot pull and the write-queue drain loop for an
// Essential Commodities facility login, and renders the honest status bar.
// Deliberately narrow: HIV and every admin/oversight tier get none of this — see
// docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms sibling project
// ("module-aware so HIV stays untouched"; reports/oversight stay online-only).
export function OfflineSync() {
  const module      = useAppStore(s => s.module)
  const accessLevel = useAppStore(s => s.accessLevel)
  const facilityId  = useAppStore(s => s.currentFacility?.id)

  const active = module === 'essential' && accessLevel === 'facility' && !!facilityId

  useEffect(() => {
    if (!active) return
    startAutoSync(facilityId)
    startDrainLoop()
    return () => { stopAutoSync(); stopDrainLoop() }
  }, [active, facilityId])

  if (!active) return null
  return <OfflineStatusBar />
}
