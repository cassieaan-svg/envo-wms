import { useEffect, useState } from 'react'
import { auth, getToken } from './lib/api'
import { useAppStore } from './store/appStore'
import { useRealtimeStock } from './hooks/useStock'
import { hydrateSession, loadModuleData } from './utils/session'
import { AuthScreen } from './components/AuthScreen'
import { ModulePicker } from './components/ModulePicker'
import { Sidebar } from './components/Sidebar'
import { Toast } from './components/ui/Toast'

// Pharmacy pages
import { Dashboard as PharmDashboard } from './pages/pharmacy/Dashboard'
import { Stock      as PharmStock      } from './pages/pharmacy/Stock'
import { RecordStock as PharmDispense   } from './pages/pharmacy/RecordStock'
import { Intake     as PharmIntake     } from './pages/pharmacy/Intake'
import { Adjustment as PharmAdjustment } from './pages/pharmacy/Adjustment'
import { Transfers  as PharmTransfers  } from './pages/pharmacy/Transfers'
import { Log        as PharmLog        } from './pages/pharmacy/Log'
import { Alerts     as PharmAlerts     } from './pages/pharmacy/Alerts'
import { Monitoring as PharmMonitoring } from './pages/pharmacy/Monitoring'

// Lab pages
import { Dashboard  as LabDashboard  } from './pages/lab/Dashboard'
import { Stock      as LabStock      } from './pages/lab/Stock'
import { RecordStock as LabDispense   } from './pages/lab/RecordStock'
import { Intake     as LabIntake     } from './pages/lab/Intake'
import { Adjustment as LabAdjustment } from './pages/lab/Adjustment'
import { Transfers  as LabTransfers  } from './pages/lab/Transfers'
import { Log        as LabLog        } from './pages/lab/Log'
import { Alerts     as LabAlerts     } from './pages/lab/Alerts'
import { Monitoring as LabMonitoring } from './pages/lab/Monitoring'

// Admin pages
import { AllFacilities } from './pages/admin/AllFacilities'

// DSD pages
import { Dispense  as DsdDispense  } from './pages/dsd/Dispense'
import { Transfers as DsdTransfers } from './pages/dsd/Transfers'
import { Stock     as DsdStock     } from './pages/dsd/Stock'

// SDP pages
import { Dispense  as SdpDispense  } from './pages/sdp/Dispense'
import { Transfers as SdpTransfers } from './pages/sdp/Transfers'
import { Stock     as SdpStock     } from './pages/sdp/Stock'

// Shared read-only activity log for SDP/DSD site logins
import { SiteActivityLog } from './components/SiteActivityLog'

// CRRF pages
import { CRRF as PharmCRRF } from './pages/pharmacy/CRRF'
import { CRRF as LabCRRF   } from './pages/lab/CRRF'

// Essential Commodities module
import { RequestWarehouse } from './pages/essential/RequestWarehouse'
import { WarehouseRequestsAdmin } from './pages/essential/WarehouseRequestsAdmin'
import { Spend } from './pages/essential/Spend'

const dsdMap = {
  dispense: DsdDispense, transfers: DsdTransfers, stock: DsdStock, log: SiteActivityLog,
}
const sdpMap = {
  dispense: SdpDispense, transfers: SdpTransfers, stock: SdpStock, log: SiteActivityLog,
}
const pharmMap = {
  dashboard: PharmDashboard, stock: PharmStock, dispense: PharmDispense,
  intake: PharmIntake, adjustment: PharmAdjustment, transfers: PharmTransfers,
  log: PharmLog, crrf: PharmCRRF,
  alerts: PharmAlerts, monitoring: PharmMonitoring,
  // Essential Commodities: facility-raised priced request to the central warehouse.
  'warehouse-requests': RequestWarehouse,
  // The facility's own purchases, in naira. Same component the admins get — the
  // endpoint pins a facility login to its own rows and hides the cross-facility
  // groupings.
  spend: Spend,
  // Reachable by the section-routed oversight viewers (cluster/lga/state) whose
  // AdminNav links here; AllFacilities adapts per-commodity, so one component fits
  // both sections. Facility users never link to it.
  'all-facilities': AllFacilities,
}
const labMap = {
  dashboard: LabDashboard, stock: LabStock, dispense: LabDispense,
  intake: LabIntake, adjustment: LabAdjustment, transfers: LabTransfers,
  log: LabLog, crrf: LabCRRF,
  alerts: LabAlerts, monitoring: LabMonitoring,
  'warehouse-requests': RequestWarehouse,
  'all-facilities': AllFacilities,
}
// Admins get Overview + Reports only — no operations (dispense / intake /
// adjustment / transfers), so those pages are deliberately omitted here.
const adminMap = {
  dashboard: PharmDashboard, stock: PharmStock, 'all-facilities': AllFacilities,
  alerts: PharmAlerts, log: PharmLog, monitoring: PharmMonitoring, crrf: PharmCRRF,
  // Essential-only, and read-only: the admin's view of what facilities have asked
  // the warehouse for. The facility page of the same name is a request FORM, so the
  // two must not share a component — hence a distinct key resolved per role.
  'warehouse-requests': WarehouseRequestsAdmin,
  spend: Spend,
}

// ── Which pages still read the global stock array ────────────────────────────
// Derived by auditing actual `store.stockData` reads, NOT by route name — the
// same page key resolves to different components per role, and several pages
// that call loadStock() never read the array at all.
//
//   pharmacy dispense = pages/pharmacy/RecordStock  → reads (lines 64, 72, 180)
//   lab      dispense = pages/lab/RecordStock       → does NOT read
//   pharmacy alerts   = pages/pharmacy/Alerts       → reads only for a FACILITY
//                                                     user (1 KB scope); its admin
//                                                     drill-in now uses the rollup
//   all-facilities    = pages/admin/AllFacilities   → no longer reads it; moved to
//                                                     the facility-grain rollup
//   lab      alerts   = pages/lab/Alerts            → does NOT read (migrated)
//
// Everything absent here — dashboards, stock tables, monitoring, activity log,
// CRRF, reports, intake, and every DSD/SDP page — derives its figures from the
// summary endpoints and must not trigger the ~464 KB stock download.
//
// KEEP IN SYNC with the route maps above: adding a page that reads stockData
// without listing it here shows that page an empty array.
const STOCK_PAGES = {
  pharm: new Set(['dispense', 'adjustment', 'transfers', 'alerts']),
  lab:   new Set(['adjustment', 'transfers']),
  admin: new Set(),
  dsd:   new Set(),
  sdp:   new Set(),
}

// Resolve the active role's page set the same way PageRouter picks its map.
function pageNeedsStockData({ page, section, accessLevel, facilityRole }) {
  const isAdmin = ['overall_admin', 'state_admin', 'lga_admin'].includes(accessLevel)
  const isDSD   = accessLevel === 'facility' && facilityRole === 'dsd'
  const isSDP   = accessLevel === 'facility' && facilityRole === 'sdp'
  const set = isSDP ? STOCK_PAGES.sdp
            : isDSD ? STOCK_PAGES.dsd
            : section === 'lab' ? STOCK_PAGES.lab
            : isAdmin ? STOCK_PAGES.admin
            : STOCK_PAGES.pharm
  return set.has(page)
}

function PageRouter() {
  const section      = useAppStore(s => s.commoditySection)
  const page         = useAppStore(s => s.currentPage)
  const accessLevel  = useAppStore(s => s.accessLevel)
  const facilityRole = useAppStore(s => s.facilityRole)
  const isAdmin      = ['overall_admin','state_admin','lga_admin'].includes(accessLevel)
  const isDSD        = accessLevel === 'facility' && facilityRole === 'dsd'
  const isSDP        = accessLevel === 'facility' && facilityRole === 'sdp'
  const isLab        = section === 'lab'
  const map          = isSDP ? sdpMap : isDSD ? dsdMap : isLab ? labMap : isAdmin ? adminMap : pharmMap
  // Daily Report, the standalone Weekly/Monthly page and admin Daily Summary
  // were folded into the Activity Log; route any persisted legacy page there so
  // existing sessions don't land on "Page not found".
  const PageComponent = map[page] || (['report','reports','dailysummary'].includes(page) ? map['log'] : undefined)
  if (!PageComponent) return (
    <div className="flex items-center justify-center h-64 text-gray-500 text-sm">Page not found</div>
  )
  return <PageComponent />
}

function MobileTopbar() {
  const section        = useAppStore(s => s.commoditySection)
  const setSidebarOpen = useAppStore(s => s.setSidebarOpen)
  return (
    <div className="lg:hidden fixed top-0 left-0 right-0 h-13 bg-gray-950 border-b border-white/8 flex items-center justify-between px-4 z-30">
      <button onClick={() => setSidebarOpen(true)} className="text-gray-400 hover:text-gray-200 p-1">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>
      <span className="text-sm font-semibold text-gray-100">
        {section === 'lab' ? 'Laboratory' : section === 'pharmacy' ? 'Pharmacy' : 'EnVo'}
      </span>
      <div className="w-8" />
    </div>
  )
}

function AppContent() {
  const theme = useAppStore(s => s.theme)   // 'system' | 'light' | 'dark'

  // Track the device colour-scheme so 'system' follows the OS and updates live
  // when the user flips their system setting.
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)
  useEffect(() => {
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mql) return
    const onChange = e => setSystemDark(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const dark = theme === 'system' ? systemDark : theme !== 'light'

  // Load (and keep live) the global stock array only while a page that actually
  // reads it is open. Recomputed on navigation, so moving onto a page that needs
  // it starts the load and moving off drops the subscription.
  const page         = useAppStore(s => s.currentPage)
  const section      = useAppStore(s => s.commoditySection)
  const accessLevel  = useAppStore(s => s.accessLevel)
  const facilityRole = useAppStore(s => s.facilityRole)
  useRealtimeStock(pageNeedsStockData({ page, section, accessLevel, facilityRole }))

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.body.style.background = dark ? '#030712' : '#f6f8fa'
    document.body.style.color      = dark ? '#e6edf3' : '#1f2328'
  }, [dark])

  return (
    <div className="min-h-screen" style={{ background: dark ? '#030712' : '#f6f8fa' }}>
      <MobileTopbar />
      <Sidebar />
      <main className="lg:ml-56 p-6 pt-20 lg:pt-6 min-h-screen">
        <div className="max-w-6xl mx-auto">
          <PageRouter />
        </div>
      </main>
    </div>
  )
}

const Spinner = () => (
  <div className="min-h-screen bg-gray-950 flex items-center justify-center">
    <div className="w-8 h-8 border-2 border-white/10 border-t-green-400 rounded-full animate-spin" />
  </div>
)

export default function App() {
  const user             = useAppStore(s => s.user)
  const module           = useAppStore(s => s.module)
  const moduleDataLoaded = useAppStore(s => s.moduleDataLoaded)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    (async () => {
      // Restore a persisted session on refresh by validating the stored JWT and
      // rebuilding the identity store from it, instead of forcing a fresh sign-in.
      if (getToken()) {
        try {
          const u = await auth.me()
          await hydrateSession(u)
        } catch {
          // Token missing/expired or hydration failed — clear it and fall
          // through to the sign-in screen.
          auth.signOut()
        }
      }
      setChecking(false)
    })()
  }, [])

  // Once a module is chosen (fresh pick or restored from sessionStorage on refresh),
  // load its scoped data. Runs for the pick flow and the refresh flow alike.
  useEffect(() => {
    if (user && module && !moduleDataLoaded) {
      loadModuleData().catch(() => auth.signOut())
    }
  }, [user, module, moduleDataLoaded])

  if (checking) return <Spinner />

  if (!user) {
    return (
      <>
        <AuthScreen onSuccess={() => {}} />
        <Toast />
      </>
    )
  }

  // Signed in but no module chosen yet → the two-card landing picker.
  if (!module) {
    return (
      <>
        <ModulePicker />
        <Toast />
      </>
    )
  }

  // Module chosen but its data hasn't finished loading yet.
  if (!moduleDataLoaded) return <Spinner />

  return (
    <>
      <AppContent />
      <Toast />
    </>
  )
}
