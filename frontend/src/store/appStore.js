import { create } from 'zustand'

export const useAppStore = create((set, get) => ({
  // Auth
  user:             null,
  accessLevel:      null,   // 'overall_admin' | 'state_admin' | 'lga_admin' | 'facility'
  facilityRole:     null,   // 'dispenser' | 'store_manager' | 'sdp' | 'dsd'
  sdpName:          null,
  dsdSiteName:      null,
  commoditySection: null,   // 'pharmacy' | 'lab' | null
  adminState:       null,
  adminLGA:         null,
  currentFacility:  null,

  // Admin filters
  adminFilterFacility: null,
  adminFilterState:    null,
  adminFilterLGA:      null,

  // Data
  allFacilities:  [],
  allCommodities: [],
  stockData:      [],
  dsdFacilities:  [],

  // UI
  sidebarOpen:    false,
  theme:          localStorage.getItem('ct_theme') || 'dark',
  currentPage:    sessionStorage.getItem('ct_page') || 'dashboard',
  currentReportCategory: 'all',
  pendingReportsTab: false,   // one-shot: open the Activity Log's Weekly/Monthly tab

  // Setters
  setUser:             (user)             => set({ user }),
  setAccessLevel:      (accessLevel)      => set({ accessLevel }),
  setFacilityRole:     (facilityRole)     => set({ facilityRole }),
  setSdpName:          (sdpName)          => set({ sdpName }),
  setDsdSiteName:      (dsdSiteName)      => set({ dsdSiteName }),
  setCommoditySection: (commoditySection) => set({ commoditySection }),
  setAdminState:       (adminState)       => set({ adminState }),
  setAdminLGA:         (adminLGA)         => set({ adminLGA }),
  setCurrentFacility:  (currentFacility)  => set({ currentFacility }),
  setAllFacilities:    (allFacilities)    => set({ allFacilities }),
  setAllCommodities:   (allCommodities)   => set({ allCommodities }),
  setStockData:        (stockData)        => set({ stockData }),
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
  setAdminFilterFacility: (f) => set({ adminFilterFacility: f }),
  setAdminFilterState:    (s) => set({ adminFilterState: s }),
  setAdminFilterLGA:      (l) => set({ adminFilterLGA: l }),

  // Access helpers
  isAdmin:        () => ['overall_admin','state_admin','lga_admin'].includes(get().accessLevel),
  isOverallAdmin: () => get().accessLevel === 'overall_admin',
  isStateAdmin:   () => get().accessLevel === 'state_admin',
  isLGAAdmin:     () => get().accessLevel === 'lga_admin',
  isFacility:     () => get().accessLevel === 'facility',
  isStoreManager: () => get().accessLevel === 'facility' && get().facilityRole === 'store_manager',
  isDispenser:    () => get().accessLevel === 'facility' && get().facilityRole === 'dispenser',
  isSDP:          () => get().accessLevel === 'facility' && get().facilityRole === 'sdp',
  isDSD:          () => get().accessLevel === 'facility' && get().facilityRole === 'dsd',
  canManageStock: () => {
    const s = get()
    return ['overall_admin','state_admin','lga_admin'].includes(s.accessLevel) ||
           (s.accessLevel === 'facility' && s.facilityRole === 'store_manager')
  },

  getEffectiveFacilityId: () => {
    const s = get()
    if (s.accessLevel === 'facility') return s.currentFacility?.id || null
    return s.adminFilterFacility?.id || null
  },

  getSectionLabel: () => {
    const s = get()
    if (s.accessLevel === 'overall_admin') return 'Overall Admin'
    if (s.accessLevel === 'state_admin')   return `${s.adminState} State Admin`
    if (s.accessLevel === 'lga_admin')     return `${s.adminLGA} LGA Admin`
    if (s.accessLevel === 'facility') {
      const section = s.commoditySection === 'pharmacy' ? 'Pharmacy'
                    : s.commoditySection === 'lab'      ? 'Lab' : ''
      const role    = s.facilityRole === 'store_manager' ? 'Store Manager'
                    : s.facilityRole === 'sdp'           ? 'Service Delivery Point'
                    : s.facilityRole === 'dsd'           ? 'Community Pharmacy / DSD'
                    : 'Dispenser'
      return [section, role].filter(Boolean).join(' ')
    }
    return 'User'
  },

  reset: () => set({
    user:null, accessLevel:null, facilityRole:null, sdpName:null, dsdSiteName:null, commoditySection:null,
    adminState:null, adminLGA:null, currentFacility:null,
    adminFilterFacility:null, adminFilterState:null, adminFilterLGA:null,
    allFacilities:[], allCommodities:[], stockData:[], dsdFacilities:[],
    currentPage:'dashboard', currentReportCategory:'all', pendingReportsTab:false
  }),
}))
