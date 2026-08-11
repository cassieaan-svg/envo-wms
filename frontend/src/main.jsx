import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, getStoredTheme, resolveDark, systemPrefersDark } from './lib/theme.js';
import './styles.css';

// Set before the first render so there's no flash of the wrong theme.
applyTheme(resolveDark(getStoredTheme(), systemPrefersDark()));

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
