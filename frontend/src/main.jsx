import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, getStoredTheme, resolveDark, systemPrefersDark } from './lib/theme.js';
import { registerServiceWorker } from './lib/pwa.js';
import './styles.css';

// Set before the first render so there's no flash of the wrong theme.
applyTheme(resolveDark(getStoredTheme(), systemPrefersDark()));

// Caches the application shell so the app OPENS without the internet. It caches no
// warehouse data — see the workbox config in vite.config.js for why.
registerServiceWorker();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
