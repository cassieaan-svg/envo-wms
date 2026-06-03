import { useEffect, useState } from 'react'
import { sb } from './lib/supabase'
import { useAppStore } from './store/appStore'
import { useRealtimeStock } from './hooks/useStock'
import { hydrateSession } from './utils/session'
import { AuthScreen } from './components/AuthScreen'
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
import { Reports    as PharmReports    } from './pages/pharmacy/Reports'
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
import { Reports    as LabReports    } from './pages/lab/Reports'
import { Alerts     as LabAlerts     } from './pages/lab/Alerts'
import { Monitoring as LabMonitoring } from './pages/lab/Monitoring'

// Admin pages
import { AllFacilities } from './pages/admin/AllFacilities'
import { DailySummary  } from './pages/admin/DailySummary'

// DSD pages
import { Dispense  as DsdDispense  } from './pages/dsd/Dispense'
import { Transfers as DsdTransfers } from './pages/dsd/Transfers'
import { Stock     as DsdStock     } from './pages/dsd/Stock'

// SDP pages
import { Dispense  as SdpDispense  } from './pages/sdp/Dispense'
import { Transfers as SdpTransfers } from './pages/sdp/Transfers'
import { Stock     as SdpStock     } from './pages/sdp/Stock'

// CRRF pages
import { CRRF as PharmCRRF } from './pages/pharmacy/CRRF'
import { CRRF as LabCRRF   } from './pages/lab/CRRF'

const dsdMap = {
  dispense: DsdDispense, transfers: DsdTransfers, stock: DsdStock,
}
const sdpMap = {
  dispense: SdpDispense, transfers: SdpTransfers, stock: SdpStock,
}
const pharmMap = {
  dashboard: PharmDashboard, stock: PharmStock, dispense: PharmDispense,
  intake: PharmIntake, adjustment: PharmAdjustment, transfers: PharmTransfers,
  log: PharmLog, reports: PharmReports, crrf: PharmCRRF,
  alerts: PharmAlerts, monitoring: PharmMonitoring,
}
const labMap = {
  dashboard: LabDashboard, stock: LabStock, dispense: LabDispense,
  intake: LabIntake, adjustment: LabAdjustment, transfers: LabTransfers,
  log: LabLog, reports: LabReports, crrf: LabCRRF,
  alerts: LabAlerts, monitoring: LabMonitoring,
}
const adminMap = { ...pharmMap, 'all-facilities': AllFacilities, 'dailysummary': DailySummary }

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
  // Daily Report was removed; fall back to Weekly/Monthly for any persisted
  // 'report' page so existing sessions don't land on "Page not found".
  const PageComponent = map[page] || (page === 'report' ? map['reports'] : undefined)
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
        {section === 'lab' ? '🧪 Laboratory' : section === 'pharmacy' ? '💊 Pharmacy' : 'EnVo'}
      </span>
      <div className="w-8" />
    </div>
  )
}

function AppContent() {
  const theme = useAppStore(s => s.theme)

  useRealtimeStock()

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme !== 'light')
    document.body.style.background = theme === 'light' ? '#f6f8fa' : '#030712'
    document.body.style.color      = theme === 'light' ? '#1f2328' : '#e6edf3'
  }, [theme])

  return (
    <div className="min-h-screen" style={{ background: theme === 'light' ? '#f6f8fa' : '#030712' }}>
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

export default function App() {
  const user     = useAppStore(s => s.user)
  const [checking, setChecking] = useState(true)
  const [authed, setAuthed]     = useState(false)

  useEffect(() => {
    sb.auth.getSession().then(async ({ data: { session } }) => {
      // Restore a persisted session on refresh by rebuilding the store from it,
      // instead of forcing the user to sign in again.
      if (session?.user) {
        try { await hydrateSession(session.user) }
        catch { /* hydration failed — fall through to the sign-in screen */ }
      }
      setChecking(false)
    })
  }, [])

  if (checking) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-white/10 border-t-green-400 rounded-full animate-spin" />
      </div>
    )
  }

  if (!user) {
    return (
      <>
        <AuthScreen onSuccess={() => setAuthed(true)} />
        <Toast />
      </>
    )
  }

  return (
    <>
      <AppContent />
      <Toast />
    </>
  )
}
