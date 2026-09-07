import { NavSection, NavItem } from '../../components/NavItem'

// Navigation for the system administrator (Phase 2M.1).
//
// DELIBERATELY MINIMAL. This account holds three ACL permissions — user.read,
// user.write, user_permission.write — and no operational access whatsoever.
// scope.js grants it nothing: 'system_admin' appears in neither
// READ_ADMIN_LEVELS nor WRITE_ADMIN_LEVELS, and the account carries no
// facility_id, so every facility guard denies it twice over.
//
// So there is no Dashboard, no Stock, no Alerts, no Monitoring, no CRRF here.
// Listing them would render pages whose every request 403s — an incoherent UI
// that also invites someone to "fix" it by handing this account a facility or a
// section, which is precisely what the Phase 2M.1 decision forbids.
//
// The menu is not the boundary. Every endpoint behind these links enforces the
// same rules server-side; hiding a link protects nobody.

const icons = {
  users: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><circle cx="6" cy="5" r="2.5"/><path d="M1 13s.8-3.5 5-3.5 5 3.5 5 3.5"/><path d="M11 3.2a2.5 2.5 0 010 4.6M12.5 12.8s-.2-1.6-1.2-2.6"/></svg>,
  features: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="3" width="14" height="4.5" rx="2.25"/><circle cx="11.5" cy="5.25" r="1.4"/><rect x="1" y="9" width="14" height="4.5" rx="2.25"/><circle cx="4.5" cy="11.25" r="1.4"/></svg>,
  catalogue: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="4" width="14" height="10" rx="1.5"/><path d="M5 4V3a3 3 0 016 0v1"/></svg>,
}

export function SystemAdminNav() {
  return (
    <>
      <NavSection>Administration</NavSection>
      <NavItem page="users"    icon={icons.users}>User &amp; Access</NavItem>
      <NavItem page="features" icon={icons.features}>Feature Configuration</NavItem>

      <NavSection>Catalogue</NavSection>
      <NavItem page="catalogue" icon={icons.catalogue}>Item Catalogue</NavItem>
    </>
  )
}
