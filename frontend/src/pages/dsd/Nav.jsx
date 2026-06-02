import { NavSection, NavItem } from '../../components/NavItem'

const icons = {
  dispense:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><circle cx="8" cy="8" r="6"/><path d="M8 5v6M5 8h6"/></svg>,
  transfers: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M2 5h12M2 11h12M10 2l3 3-3 3M6 8l-3 3 3 3"/></svg>,
  stock:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="4" width="14" height="10" rx="1.5"/><path d="M5 4V3a3 3 0 016 0v1"/></svg>,
}

export function DsdNav() {
  return (
    <>
      <NavSection>Operations</NavSection>
      <NavItem page="dispense"   icon={icons.dispense}>Record Stock Consumed</NavItem>
      <NavItem page="transfers"  icon={icons.transfers}>Redistribution &amp; Emergency Order</NavItem>

      <NavSection>Overview</NavSection>
      <NavItem page="stock"      icon={icons.stock}>Stock Levels</NavItem>
    </>
  )
}
