import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { subscribeRealtime } from '../../lib/realtime'
import { NavSection, NavItem } from '../../components/NavItem'
import { useAppStore } from '../../store/appStore'

const icons = {
  dispense:      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><circle cx="8" cy="8" r="6"/><path d="M8 5v6M5 8h6"/></svg>,
  intake:        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M2 13h12"/></svg>,
  adjustment:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M2 8h12M8 2v12"/><circle cx="8" cy="8" r="3"/></svg>,
  transfers:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M2 5h12M2 11h12M10 2l3 3-3 3M6 8l-3 3 3 3"/></svg>,
  dashboard:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>,
  stock:         <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="4" width="14" height="10" rx="1.5"/><path d="M5 4V3a3 3 0 016 0v1"/></svg>,
  facilities:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M1 13s1-4 7-4 7 4 7 4"/><circle cx="8" cy="6" r="3"/></svg>,
  alerts:        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M8 1L1 13h14L8 1z"/><path d="M8 6v4M8 11v1"/></svg>,
  log:           <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M2 4h12M2 8h8M2 12h10"/></svg>,
  report:        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="1" width="14" height="14" rx="2"/><path d="M5 10l2-3 2 2 2-4"/></svg>,
  reports:       <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="1" width="14" height="14" rx="2"/><path d="M4 12V8M7 12V6M10 12V4M13 12V9"/></svg>,
  dailysummary:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="1" width="14" height="14" rx="2"/><path d="M4 11l2-4 2 3 2-5 2 3"/></svg>,
  monitoring:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M4 10l2-3 2 2 2-3 2 2"/></svg>,
  crrf:          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="1" width="14" height="14" rx="2"/><line x1="4" y1="5" x2="12" y2="5"/><line x1="4" y1="8" x2="12" y2="8"/><line x1="4" y1="11" x2="9" y2="11"/></svg>,
}

export function AdminNav() {
  const store = useAppStore()
  const [pendingRequestCount, setPendingRequestCount] = useState(0)

  useEffect(() => {
    loadPendingCount()
    return subscribeRealtime(['stock_transfer_log'], loadPendingCount)
  }, [])

  async function loadPendingCount() {
    // Overall admin doesn't handle redistribution requests, so its Alerts badge
    // shouldn't count them.
    if (store.isOverallAdmin()) { setPendingRequestCount(0); return }
    // Pending requests still awaiting a source assignment (sending_facility_id
    // null). The server scopes the list to the admin's jurisdiction.
    try {
      const rows = await api.transfers.list({ status: 'pending' })
      setPendingRequestCount((rows || []).filter(t => !t.sending_facility_id).length)
    } catch { setPendingRequestCount(0) }
  }

  return (
    <>
      <NavSection>Overview</NavSection>
      <NavItem page="dashboard"      icon={icons.dashboard}>Dashboard</NavItem>
      <NavItem page="stock"          icon={icons.stock}>Stock Levels</NavItem>
      <NavItem page="all-facilities" icon={icons.facilities}>All Facilities</NavItem>
      <NavItem page="alerts" icon={icons.alerts} badge={pendingRequestCount}>Alerts</NavItem>

      <NavSection>Reports</NavSection>
      <NavItem page="log"          icon={icons.log}>Activity Log</NavItem>
      <NavItem page="monitoring"   icon={icons.monitoring}>Monitoring</NavItem>
      <NavItem page="crrf"         icon={icons.crrf}>CRRF</NavItem>
    </>
  )
}

