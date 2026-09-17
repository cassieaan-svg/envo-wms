import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// PWA scaffolding — service worker + manifest, ported from envo-wms's own working
// vite-plugin-pwa setup (see docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in that
// sibling project for the design). This ONE build serves both HIV and Essential
// Commodities (the module picker chooses at runtime), so the shell caching below is
// module-agnostic and changes nothing about HIV — it's app-shell-only, same as the
// warehouse app's own worker: no facility/stock/catalogue data is ever cached here,
// only the HTML/JS/CSS/fonts/icons needed for the app to OPEN with no connection.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt', not 'autoUpdate' — same reasoning as the warehouse app: an
      // automatic reload could refresh the page out from under someone half-way
      // through recording a dispense or intake.
      registerType: 'prompt',
      includeAssets: ['favicon-64.png', 'apple-touch-icon.png'],

      manifest: {
        name: 'EnVo',
        short_name: 'EnVo',
        description: 'HIV and Essential Commodities stock management for facilities.',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        background_color: '#030712',
        theme_color: '#16a34a',
        categories: ['business', 'medical', 'productivity'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          // Purpose 'maskable' is a separate entry, not an extra purpose on the icon
          // above: a platform that crops to a circle would otherwise cut into the mark.
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },

      workbox: {
        // Precache the shell only.
        globPatterns: ['**/*.{js,css,html,woff,woff2,png,svg}'],

        // THE IMPORTANT PART, identical in spirit to the warehouse app's own worker.
        //
        // Not a performance decision. Catalogue, stock, dispense/intake/adjustment
        // history and warehouse-request status are the facility's live truth from
        // the central backend; a service worker answering from cache would show a
        // store manager a quantity that no longer exists and let them dispense
        // against it. The shell is cached so the app OPENS with no connection — the
        // data behind it always comes from the network, or (once the IndexedDB layer
        // and drain loop exist — not built yet) from the local write queue, never
        // from this cache.
        navigateFallbackDenylist: [/^\/api/, /^\/health/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /^\/(api|health)/.test(url.pathname),
            handler: 'NetworkOnly',
          },
        ],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },

      devOptions: {
        // Off in dev: a service worker caching a hot-reloading build is a source of
        // confusing staleness, and PWA behaviour is verified against a real build.
        enabled: false,
      },
    }),
  ],
  server: {
    // Vite refuses requests whose Host header it doesn't recognise, which makes a
    // Cloudflare quick tunnel return 403. Allow the tunnel domain so the dev server
    // can be shared. Dev-server only — it has no effect on a production build.
    allowedHosts: ['.trycloudflare.com'],
  },
  build: {
    // Emit to the repo-root /dist so Netlify (which publishes root "dist") finds it.
    outDir: '../dist',
    emptyOutDir: true,
  },
})
