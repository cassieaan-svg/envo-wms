import { useCallback, useEffect, useState } from 'react';
import { auth, getStoredUser, getToken } from './lib/api.js';
import LoginPage from './pages/LoginPage.jsx';
import VendorsPage from './pages/VendorsPage.jsx';
import CommoditiesPricesPage from './pages/CommoditiesPricesPage.jsx';
import PriceImportPage from './pages/PriceImportPage.jsx';
import BatchesPage from './pages/BatchesPage.jsx';
import DispatchPage from './pages/DispatchPage.jsx';
import AlertsPage from './pages/AlertsPage.jsx';
import FacilitiesPage from './pages/FacilitiesPage.jsx';

// Tab-based navigation rather than a router — the page count is small and every view is
// reachable from one bar, matching how EnVo itself switches views.
const TABS = {
  Alerts: AlertsPage,
  'Commodities & Prices': CommoditiesPricesPage,
  Batches: BatchesPage,
  Dispatch: DispatchPage,
  'Price List Import': PriceImportPage,
  Vendors: VendorsPage,
  Facilities: FacilitiesPage,
};

export default function App() {
  const [user, setUser] = useState(() => (getToken() ? getStoredUser() : null));
  const [tab, setTab] = useState('Alerts');

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

  if (!user) return <LoginPage onSignedIn={setUser} />;

  const Page = TABS[tab];
  const isAdmin = user.role === 'admin';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          EnVo <span>WMS</span>
        </div>
        <nav className="tabs">
          {Object.keys(TABS).map((name) => (
            <button
              key={name}
              className={`tab ${tab === name ? 'active' : ''}`}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <span>{user.fullName || user.username}</span>
          <span className="role-chip">{user.role}</span>
          <button className="btn small" onClick={signOut}>
            sign out
          </button>
        </div>
      </header>
      <main>
        <Page isAdmin={isAdmin} />
      </main>
    </div>
  );
}
