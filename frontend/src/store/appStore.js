import { create } from 'zustand'
import { setModule as apiSetModule, clearModule as apiClearModule } from '../lib/api'

export const useAppStore = create((set, get) => ({
  // Auth
  user:             null,

  // Active commodity programme ('hiv' | 'essential'). Chosen on the post-login
  // module picker; sent to the backend as the x-envo-module header (see lib/api).
  // Restored from sessionStorage so a refresh stays in the same module.
  module:           (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('ct_module')) || null,
  availableModules: [],   // [{ key, label, enrolled }] from GET /api/modules
  moduleDataLoaded: false, // false until the chosen module's facilities/commodities load
  // 'overall_admin' | 'state_admin' | 'state_viewer' | 'cluster_admin' | 'lga_admin' | 'facility'
  // Writers: state_admin + facility. Read-only oversight: overall_admin, state_viewer,
  // cluster_admin, lga_admin (the server enforces this; the UI just hides write actions).
  accessLevel:      null,
  facilityRole:     null,   // 'dispenser' | 'store_manager' | 'sdp' | 'dsd'
  sdpName:          null,
  dsdSiteName:      null,
  dsdType:          null,   // DSD model for a dsd login: 'Community Pharmacy' | 'Fast Track' | …
  commoditySection: null,   // 'pharmacy' | 'lab' | null
  adminState:       null,
  adminLGA:         null,
  adminCluster:     null,
  currentFacility:  null,

  // Admin filters
  adminFilterFacility: null,
  adminFilterState:    null,
  adminFilterLGA:      null,

  // Data
  allFacilities:  [],
  allCommodities: [],
  stockData:      [],
  // False until the first /api/stock response lands. Pages must not derive
  // stock alerts from an empty stockData — every commodity would look
  // out-of-stock — so they gate on this instead of on stockData.length.
  stockLoaded:    false,
  dsdFacilities:  [],
  amcWindows:     {},   // facility_id → { months: ['YYYY-MM', ...] } | absent = default window

  // UI
  sidebarOpen:    false,
  theme:          localStorage.getItem('ct_theme') || 'system', // 'system' | 'light' | 'dark'
  currentPage:    sessionStorage.getItem('ct_page') || 'dashboard',
  currentReportCategory: 'all',
  pendingReportsTab: false,   // one-shot: open the Activity Log's Weekly/Monthly tab

  // Setters
  setUser:             (user)             => set({ user }),
  setModule:           (module)           => { apiSetModule(module); set({ module }) },
  setAvailableModules: (availableModules) => set({ availableModules }),
  setModuleDataLoaded: (moduleDataLoaded) => set({ moduleDataLoaded }),
  // Back to the module picker (clears the choice + its loaded data, keeps the session).
  clearModule:         ()                 => { apiClearModule(); set({ module: null, moduleDataLoaded: false, currentPage: 'dashboard' }) },
  setAccessLevel:      (accessLevel)      => set({ accessLevel }),
  setFacilityRole:     (facilityRole)     => set({ facilityRole }),
  setSdpName:          (sdpName)          => set({ sdpName }),
  setDsdSiteName:      (dsdSiteName)      => set({ dsdSiteName }),
  setDsdType:          (dsdType)          => set({ dsdType }),
  setCommoditySection: (commoditySection) => set({ commoditySection }),
  setAdminState:       (adminState)       => set({ adminState }),
  setAdminLGA:         (adminLGA)         => set({ adminLGA }),
  setAdminCluster:     (adminCluster)     => set({ adminCluster }),
  setCurrentFacility:  (currentFacility)  => set({ currentFacility }),
  setAllFacilities:    (allFacilities)    => set({ allFacilities }),
  setAllCommodities:   (allCommodities)   => set({ allCommodities }),
  setStockData:        (stockData)        => set({ stockData, stockLoaded: true }),
  setDsdFacilities:    (dsdFacilities)    => set({ dsdFacilities }),
  setSidebarOpen:      (sidebarOpen)      => set({ sidebarOpen }),
  setCurrentPage:      (page)             => {
    sessionStorage.setItem('ct_page', page)
    set({ currentPage: page })
  },
  setCurrentReportCategory: (currentReportCategory) => set({ currentReportCategory }),
  setPendingReportsTab: (pendingReportsTab) => set({ pendingReportsTab }),
  setTheme: (theme) => {
    localStorage.setItem('ct_theme', theme)
    set({ theme })
  },
  setAmcWindows: (amcWindows) => set({ amcWindows }),
  setAmcWindow:  (facilityId, win) => set(s => {
    const next = { ...s.amcWindows }
    if (win) next[facilityId] = win
    else delete next[facilityId]
    return { amcWindows: next }
  }),
  setAdminFilterFacility: (f) => set({ adminFilterFacility: f }),
  setAdminFilterState:    (s) => set({ adminFilterState: s }),
  setAdminFilterLGA:      (l) => set({ adminFilterLGA: l }),

  // Access helpers.
  // isAdmin = "sees the multi-facility oversight views" — all tiers above facility,
  // including the read-only viewers. It does NOT imply write access; gate write
  // actions on canManageStock()/isReadOnly() instead.
  // system_admin is DELIBERATELY ABSENT from isAdmin(): it has no operational
  // access at all, so every oversight page this flag unlocks would call endpoints
  // that correctly 403. It administers users, not stock — see isSystemAdmin.
  isAdmin:        () => ['overall_admin','state_admin','state_viewer','cluster_admin','lga_admin'].includes(get().accessLevel),
  isOverallAdmin: () => get().accessLevel === 'overall_admin',
  // The system-administration identity (Phase 2M.1). Holds exactly three ACL
  // permissions — user.read, user.write, user_permission.write — and no facility,
  // section or module scope. It is not a super-user: scope.js grants it nothing,
  // and this flag must only ever gate the administration surface.
  isSystemAdmin:  () => get().accessLevel === 'system_admin',
  isStateAdmin:   () => get().accessLevel === 'state_admin',
  isStateViewer:  () => get().accessLevel === 'state_viewer',
  isClusterAdmin: () => get().accessLevel === 'cluster_admin',
  isLGAAdmin:     () => get().accessLevel === 'lga_admin',
  isFacility:     () => get().accessLevel === 'facility',
  isStoreManager: () => get().accessLevel === 'facility' && get().facilityRole === 'store_manager',
  isDispenser:    () => get().accessLevel === 'facility' && get().facilityRole === 'dispenser',
  isSDP:          () => get().accessLevel === 'facility' && get().facilityRole === 'sdp',
  isDSD:          () => get().accessLevel === 'facility' && get().facilityRole === 'dsd',
  // Read-only oversight accounts: can view across their scope but never write.
  isReadOnly:     () => ['overall_admin','state_viewer','cluster_admin','lga_admin'].includes(get().accessLevel),
  canManageStock: () => {
    const s = get()
    // Among the admin tiers, only state_admin writes; facility store managers write
    // their own facility. Read-only viewers (overall/state_viewer/cluster/lga) cannot.
    return s.accessLevel === 'state_admin' ||
           (s.accessLevel === 'facility' && s.facilityRole === 'store_manager')
  },

  getEffectiveFacilityId: () => {
    const s = get()
    if (s.accessLevel === 'facility') return s.currentFacility?.id || null
    return s.adminFilterFacility?.id || null
  },

  // Resolve the current facility scope for stock queries into either a single
  // facility id (`fid`) or a list of facility ids (`scopeIds`). Honours the
  // admin's hierarchical filter: facility → LGA → state → everything overseen.
  getAdminStockScope: () => {
    const s = get()
    if (s.accessLevel === 'facility') return { fid: s.currentFacility?.id || null, scopeIds: null }
    if (s.adminFilterFacility) return { fid: s.adminFilterFacility.id, scopeIds: null }
    if (s.adminFilterState || s.adminFilterLGA) {
      const ids = s.allFacilities
        .filter(f => (!s.adminFilterState || f.state === s.adminFilterState) &&
                     (!s.adminFilterLGA   || f.lga   === s.adminFilterLGA))
        .map(f => f.id)
      return { fid: null, scopeIds: ids }
    }
    // No narrowing: state/LGA admins span the facilities they oversee; overall
    // admin spans everything (null = no facility constraint).
    if (s.accessLevel !== 'overall_admin') return { fid: null, scopeIds: s.allFacilities.map(f => f.id) }
    return { fid: null, scopeIds: null }
  },

  // Compact query params for the current scope, for endpoints that resolve
  // state/lga server-side. Avoids enumerating (hundreds of) facility ids in the
  // URL, which overflows proxy request-URI limits on large states. Shapes:
  //   { facility_id } | { state[, lga] } | {}  ({} = backend uses the token scope)
  getAdminScopeParams: () => {
    const s = get()
    if (s.accessLevel === 'facility') return { facility_id: s.currentFacility?.id || undefined }
    if (s.adminFilterFacility) return { facility_id: s.adminFilterFacility.id }
    const p = {}
    if (s.adminFilterState) p.state = s.adminFilterState
    if (s.adminFilterLGA)   p.lga   = s.adminFilterLGA
    return p
  },

  getSectionLabel: () => {
    const s = get()
    if (s.accessLevel === 'system_admin') return 'System Administrator'
    if (s.accessLevel === 'overall_admin') {
      if (s.commoditySection === 'lab')      return 'Lab HQ'
      if (s.commoditySection === 'pharmacy') return 'Pharmacy HQ'
      return 'Overall Admin'
    }
    if (s.accessLevel === 'state_admin')   return `${s.adminState} State Admin`
    if (s.accessLevel === 'state_viewer') {
      const sec = s.commoditySection === 'pharmacy' ? 'Pharmacy' : s.commoditySection === 'lab' ? 'Lab' : ''
      return [`${s.adminState} State`, sec].filter(Boolean).join(' ')
    }
    if (s.accessLevel === 'cluster_admin') {
      const sec = s.commoditySection === 'pharmacy' ? 'Pharmacy' : s.commoditySection === 'lab' ? 'Lab' : ''
      return [`${s.adminCluster} Cluster`, sec].filter(Boolean).join(' ')
    }
    if (s.accessLevel === 'lga_admin') {
      const sec = s.commoditySection === 'pharmacy' ? 'Pharmacy' : s.commoditySection === 'lab' ? 'Lab' : ''
      return [`${s.adminLGA} LGA`, sec].filter(Boolean).join(' ')
    }
    if (s.accessLevel === 'facility') {
      const section = s.commoditySection === 'pharmacy' ? 'Pharmacy'
                    : s.commoditySection === 'lab'      ? 'Lab' : ''
      const role    = s.facilityRole === 'store_manager' ? 'Store Manager'
                    : s.facilityRole === 'sdp'           ? 'Service Delivery Point'
                    : s.facilityRole === 'dsd'           ? 'DSD'
                    : 'Dispenser'
      return [section, role].filter(Boolean).join(' ')
    }
    return 'User'
  },

  reset: () => {
    apiClearModule()
    set({
      user:null, accessLevel:null, facilityRole:null, sdpName:null, dsdSiteName:null, dsdType:null, commoditySection:null,
      adminState:null, adminLGA:null, adminCluster:null, currentFacility:null,
      adminFilterFacility:null, adminFilterState:null, adminFilterLGA:null,
      allFacilities:[], allCommodities:[], stockData:[], stockLoaded:false, dsdFacilities:[], amcWindows:{},
      module:null, availableModules:[], moduleDataLoaded:false,
      currentPage:'dashboard', currentReportCategory:'all', pendingReportsTab:false
    })
  },
}))
