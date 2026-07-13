import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { subscribeRealtime } from '../../lib/realtime'
import { NavSection, NavItem } from '../../components/NavItem'
import { useAppStore } from '../../store/appStore'

const icons = {
  dispense:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><circle cx="8" cy="8" r="6"/><path d="M8 5v6M5 8h6"/></svg>,
  transfers: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M2 5h12M2 11h12M10 2l3 3-3 3M6 8l-3 3 3 3"/></svg>,
  stock:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="4" width="14" height="10" rx="1.5"/><path d="M5 4V3a3 3 0 016 0v1"/></svg>,
  log:       <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M3 2h10v12H3zM6 5h4M6 8h4M6 11h2"/></svg>,
}

export function DsdNav() {
  const fid = useAppStore(s => s.currentFacility?.id)
  const commoditySection = useAppStore(s => s.commoditySection)
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    if (!fid) { setPendingCount(0); return }
    loadPendingCount()
    return subscribeRealtime(['stock_transfer_log'], loadPendingCount)
  }, [fid, commoditySection])

  async function loadPendingCount() {
    if (!fid) { setPendingCount(0); return }
    // Incoming transfers awaiting this site (pending/in_transit) plus any outgoing
    // request it's owed an action on (admin-assigned dispatch / approval / in-transit).
    try {
      const [incoming, outgoing] = await Promise.all([
        api.transfers.list({ facility_id: fid, direction: 'incoming', status: 'pending,in_transit', section: commoditySection || undefined }),
        api.transfers.list({ facility_id: fid, direction: 'outgoing', status: 'pending,pending_approval,in_transit', section: commoditySection || undefined }),
      ])
      setPendingCount((incoming?.length || 0) + (outgoing?.length || 0))
    } catch { setPendingCount(0) }
  }

  return (
    <>
      <NavSection>Operations</NavSection>
      <NavItem page="dispense"   icon={icons.dispense}>Record Stock Consumed</NavItem>
      <NavItem page="transfers"  icon={icons.transfers} badge={pendingCount}>Redistribution &amp; Emergency Order</NavItem>

      <NavSection>Overview</NavSection>
      <NavItem page="stock"      icon={icons.stock}>Stock Levels</NavItem>
      <NavItem page="log"        icon={icons.log}>Activity Log</NavItem>
    </>
  )
}
