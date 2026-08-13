import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { subscribeRealtime } from '../../lib/realtime'
import { NavSection, NavItem } from '../../components/NavItem'
import { useAppStore } from '../../store/appStore'
import { fetchFacilityAlertCounts } from '../../utils/alertCounts'

const icons = {
  dispense:   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><circle cx="8" cy="8" r="6"/><path d="M8 5v6M5 8h6"/></svg>,
  intake:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M2 13h12"/></svg>,
  adjustment: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M2 8h12M8 2v12"/><circle cx="8" cy="8" r="3"/></svg>,
  transfers:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M2 5h12M2 11h12M10 2l3 3-3 3M6 8l-3 3 3 3"/></svg>,
  dashboard:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>,
  stock:      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="4" width="14" height="10" rx="1.5"/><path d="M5 4V3a3 3 0 016 0v1"/></svg>,
  alerts:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M8 1L1 13h14L8 1z"/><path d="M8 6v4M8 11v1"/></svg>,
  log:        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M2 4h12M2 8h8M2 12h10"/></svg>,
  report:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="1" width="14" height="14" rx="2"/><path d="M5 10l2-3 2 2 2-4"/></svg>,
  reports:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="1" width="14" height="14" rx="2"/><path d="M4 12V8M7 12V6M10 12V4M13 12V9"/></svg>,
  monitoring: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M4 10l2-3 2 2 2-3 2 2"/></svg>,
  crrf:       <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="1" width="14" height="14" rx="2"/><line x1="4" y1="5" x2="12" y2="5"/><line x1="4" y1="8" x2="12" y2="8"/><line x1="4" y1="11" x2="9" y2="11"/></svg>,
}

export function LabNav() {
  const canManage    = useAppStore(s => s.canManageStock())
  const facilityRole = useAppStore(s => s.facilityRole)
  const fid          = useAppStore(s => s.currentFacility?.id)
  const commoditySection = useAppStore(s => s.commoditySection)
  const module       = useAppStore(s => s.module)
  const isDispenser  = facilityRole === 'dispenser'
  const isSDP        = facilityRole === 'sdp'
  const isRestricted = isSDP
  const isEssential  = module === 'essential'

  const [pendingCount, setPendingCount] = useState(0)
  const [alertCount, setAlertCount]     = useState(0)

  useEffect(() => {
    if (!fid) { setPendingCount(0); setAlertCount(0); return }
    loadPendingCount()
    loadAlertCount()
    const unsubT = subscribeRealtime(['stock_transfer_log'], loadPendingCount)
    const unsubS = subscribeRealtime(['stock'], loadAlertCount)
    return () => { unsubT?.(); unsubS?.() }
  }, [fid, commoditySection])

  async function loadPendingCount() {
    if (!fid) { setPendingCount(0); return }
    // Anything still needing this facility's attention: incoming transfers awaiting
    // it (pending/in_transit), plus outgoing approvals it owes (pending_approval/in_transit).
    try {
      const [incoming, outgoing] = await Promise.all([
        api.transfers.list({ facility_id: fid, direction: 'incoming', status: 'pending,in_transit', section: commoditySection || undefined }),
        api.transfers.list({ facility_id: fid, direction: 'outgoing', status: 'pending,pending_approval,in_transit', section: commoditySection || undefined }),
      ])
      setPendingCount((incoming?.length || 0) + (outgoing?.length || 0))
    } catch { setPendingCount(0) }
  }

  async function loadAlertCount() {
    if (!fid) { setAlertCount(0); return }
    const s = useAppStore.getState()
    // Expiry + low stock + overstock (out-of-stock excluded by request).
    const { total } = await fetchFacilityAlertCounts({
      fid, allCommodities: s.allCommodities, amcWindows: s.amcWindows, commoditySection,
    }).catch(() => ({ total: 0 }))
    setAlertCount(total || 0)
  }

  return (
    <>
      <NavSection>Operations</NavSection>
      <NavItem page="dispense"   icon={icons.dispense}>Record Stock Utilized</NavItem>
      {!isRestricted && <NavItem page="intake"     icon={icons.intake}     disabled={!canManage}>Stock Intake</NavItem>}
      {!isRestricted && <NavItem page="adjustment" icon={icons.adjustment} disabled={!canManage}>Adjustment</NavItem>}
      {isEssential && !isRestricted && <NavItem page="warehouse-requests" icon={icons.transfers} disabled={!canManage}>Request from Warehouse</NavItem>}
      <NavItem page="transfers" icon={icons.transfers} badge={pendingCount}>Redistribution & Emergency Order</NavItem>

      {!isRestricted && <NavSection>Overview</NavSection>}
      {!isRestricted && <NavItem page="dashboard" icon={icons.dashboard}>Dashboard</NavItem>}
      <NavItem page="stock"     icon={icons.stock}>Stock Levels</NavItem>
      {!isRestricted && <NavItem page="alerts"    icon={icons.alerts} badge={pendingCount + alertCount}>Alerts</NavItem>}

      {!isRestricted && <NavSection>Reports</NavSection>}
      {!isRestricted && <NavItem page="log"        icon={icons.log}>Activity Log</NavItem>}
      {!isRestricted && <NavItem page="monitoring" icon={icons.monitoring}>Monitoring</NavItem>}
      {!isRestricted && <NavItem page="crrf"       icon={icons.crrf} disabled={isDispenser}>CRRF</NavItem>}
    </>
  )
}
