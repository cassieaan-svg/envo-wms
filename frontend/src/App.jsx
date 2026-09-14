import { useCallback, useEffect, useState } from 'react';
import { auth, getStoredUser, getToken } from './lib/api.js';
import { applyTheme, getStoredTheme, resolveDark, storeTheme, systemPrefersDark } from './lib/theme.js';
import ChangePasswordModal from './components/ChangePasswordModal.jsx';
import ThemeSwitch from './components/ThemeSwitch.jsx';
import ConnectionBar from './components/ConnectionBar.jsx';
import LoginPage from './pages/LoginPage.jsx';
import VendorsPage from './pages/VendorsPage.jsx';
import CommoditiesPricesPage from './pages/CommoditiesPricesPage.jsx';
import BatchesPage from './pages/BatchesPage.jsx';
import DispatchPage from './pages/DispatchPage.jsx';
import RequestsPage from './pages/RequestsPage.jsx';
import AlertsPage from './pages/AlertsPage.jsx';
import FacilitiesPage from './pages/FacilitiesPage.jsx';
import MonitoringPage from './pages/MonitoringPage.jsx';
import ActivityLogPage from './pages/ActivityLogPage.jsx';
import AdjustmentsPage from './pages/AdjustmentsPage.jsx';
import AccountsPage from './pages/AccountsPage.jsx';
import UsersPage from './pages/UsersPage.jsx';

// 16x16 stroked outlines, matching the icon set EnVo uses in its own nav.
const icon = (paths) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    {paths}
  </svg>
);

const ICONS = {
  dispatch: icon(
    <>
      <path d="M2 5h12M2 11h12" />
      <path d="M10 2l3 3-3 3M6 8l-3 3 3 3" />
    </>
  ),
  requests: icon(
    <>
      <path d="M3 2h8l3 3v9H3z" />
      <path d="M6 7h5M6 10h5" />
    </>
  ),
  batches: icon(
    <>
      <rect x="1" y="4" width="14" height="10" rx="1.5" />
      <path d="M5 4V3a3 3 0 016 0v1" />
    </>
  ),
  commodities: icon(
    <>
      <rect x="1" y="1" width="14" height="14" rx="2" />
      <path d="M4 5h8M4 8h8M4 11h5" />
    </>
  ),
  facilities: icon(
    <>
      <path d="M1 13s1-4 7-4 7 4 7 4" />
      <circle cx="8" cy="6" r="3" />
    </>
  ),
  vendors: icon(
    <>
      <path d="M2 6h12l-1 8H3L2 6z" />
      <path d="M5 6V4a3 3 0 016 0v2" />
    </>
  ),
  alerts: icon(
    <>
      <path d="M8 1L1 13h14L8 1z" />
      <path d="M8 6v4M8 11v1" />
    </>
  ),
  monitoring: icon(
    <>
      <path d="M1 14h14" />
      <path d="M3 11V7M7 11V3M11 11V6M15 11V9" />
    </>
  ),
  activity: icon(
    <>
      <path d="M1 8h3l2 5 4-11 2 6h3" />
    </>
  ),
  adjustments: icon(
    <>
      <path d="M3 2v12M13 2v12" />
      <path d="M1 6h4M11 10h4" />
    </>
  ),
  users: icon(
    <>
      <circle cx="6" cy="5" r="2.5" />
      <path d="M1 14c0-2.8 2.2-5 5-5s5 2.2 5 5" />
      <path d="M11 3.5a2.5 2.5 0 010 5M14.5 14c0-2.3-1.7-4.2-4-4.8" />
    </>
  ),
};

// Grouped side-rail navigation rather than a router — the page count is small and every
// view is reachable from one list, matching how EnVo itself switches views.
// Operations is the daily work, Catalogue the reference data you maintain.
const NAV = [
  [
    'Operations',
    [
      ['Requests', RequestsPage, ICONS.requests],
      ['Dispatch', DispatchPage, ICONS.dispatch],
      ['Intake Batches', BatchesPage, ICONS.batches],
      ['Adjustments', AdjustmentsPage, ICONS.adjustments],
    ],
  ],
  [
    'Catalogue',
    [
      ['Commodities', CommoditiesPricesPage, ICONS.commodities],
      ['Facilities', FacilitiesPage, ICONS.facilities],
      ['Vendors', VendorsPage, ICONS.vendors],
    ],
  ],
  [
    'Reports',
    [
      ['Accounts', AccountsPage, ICONS.monitoring],
      ['Monitoring', MonitoringPage, ICONS.monitoring],
      ['Activity log', ActivityLogPage, ICONS.activity],
      ['Alerts', AlertsPage, ICONS.alerts],
    ],
  ],
  [
    'Administration',
    [
      // A 4th element names the permission required to see this tab at all — System
      // Administrator and Warehouse Admin both hold users.create (see the Phase 1 matrix);
      // Picker/Dispatcher and Receiving Clerk do not, and never see this entry. This is UX
      // only: the real enforcement is server-side (requirePermission on every /api/admin
      // route), so a hidden tab is a courtesy, not the security boundary.
      ['Users', UsersPage, ICONS.users, 'users.create'],
    ],
  ],
];

const PAGES = Object.fromEntries(NAV.flatMap(([, items]) => items.map(([n, p]) => [n, p])));

export default function App() {
  const [user, setUser] = useState(() => (getToken() ? getStoredUser() : null));
  const [tab, setTab] = useState('Dispatch');
  const [navOpen, setNavOpen] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);
  const [theme, setTheme] = useState(getStoredTheme);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  const signOut = useCallback(() => {
    auth.logout();
    setUser(null);
  }, []);

  // api.js dispatches this when any request comes back 401, so an expired token drops
  // straight back to the login screen instead of leaving a half-broken page.
  useEffect(() => {
    window.addEventListener('envo-wms-unauthorized', signOut);
    return () => window.removeEventListener('envo-wms-unauthorized', signOut);
  }, [signOut]);

  // Keep 'system' following the OS live, rather than only at load.
  useEffect(() => {
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mql) return undefined;
    const onChange = (e) => setSystemDark(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    applyTheme(resolveDark(theme, systemDark));
  }, [theme, systemDark]);

  // Escape closes the mobile drawer, matching the modals.
  useEffect(() => {
    if (!navOpen) return undefined;
    const onKey = (e) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  function pickTheme(next) {
    setTheme(next);
    storeTheme(next);
  }

  if (!user) return <LoginPage onSignedIn={setUser} />;

  const Page = PAGES[tab];
  const isAdmin = user.role === 'admin';
  const permissions = user.permissions || [];
  const can = (perm) => permissions.includes(perm);

  function pick(name) {
    setTab(name);
    setNavOpen(false);
  }

  return (
    <div className="app-shell">
      {/* Only rendered on narrow screens; the rail is always visible on desktop. */}
      <div className="mobile-topbar">
        <button className="icon-btn" onClick={() => setNavOpen(true)} aria-label="Open menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <span className="mobile-title">{tab}</span>
        <span className="icon-btn-spacer" />
      </div>

      {navOpen && <div className="nav-overlay" onClick={() => setNavOpen(false)} />}

      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="brand">
          EnVo <span>Warehouse</span>
        </div>

        <div className="sidebar-identity">
          <div className="eyebrow">Logged in as</div>
          <div className="who">{user.fullName || user.username}</div>
          <span className="role-chip">{user.role}</span>
        </div>

        <nav>
          {NAV.map(([group, items]) => {
            const visible = items.filter(([, , , perm]) => !perm || can(perm));
            if (!visible.length) return null;
            return (
              <div className="nav-group" key={group}>
                <div className="nav-group-label">{group}</div>
                <div className="tabs">
                  {visible.map(([name, , glyph]) => (
                    <button
                      key={name}
                      className={`tab ${tab === name ? 'active' : ''}`}
                      onClick={() => pick(name)}
                    >
                      {glyph}
                      <span>{name}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <ThemeSwitch theme={theme} onChange={pickTheme} />
          <button className="btn" onClick={() => setShowChangePw(true)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="7" width="10" height="7" rx="1" />
              <path d="M5 7V5a3 3 0 016 0v2" />
            </svg>
            Change password
          </button>
          <button className="btn signout" onClick={signOut}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M10 11l3-3-3-3M13 8H6" />
            </svg>
            Sign out
          </button>
        </div>
      </aside>

      <main>
        <ConnectionBar />
        <Page isAdmin={isAdmin} currentUser={user} />
      </main>

      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
    </div>
  );
}
