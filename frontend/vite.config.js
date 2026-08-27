import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The proxy exists for one case: reaching the app over a tunnel (Cloudflare, ngrok) for a
// demo. The browser is then on someone else's machine, where `localhost:5100` is their PC
// and not the store server, so the API has to arrive on the same origin as the page and
// be forwarded from here. Set VITE_API_URL= (empty) to make the client use same-origin
// paths and go through this proxy.
//
// It changes nothing for the normal LAN deployment, which builds with an absolute
// VITE_API_URL and never runs the dev server.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt', not 'autoUpdate'. An automatic reload is fine for a content site and
      // wrong here: it would refresh the page out from under someone half-way through
      // keying a dispatch. The user is told and chooses when.
      registerType: 'prompt',
      includeAssets: ['favicon-64.png', 'apple-touch-icon.png'],

      manifest: {
        name: 'EnVo Warehouse — Central Medical Store',
        short_name: 'CMS Warehouse',
        description:
          'Stock, receiving, dispatch and facility requests for the Central Medical Store. '
          + 'Works on the warehouse network whether or not the internet is available.',
        // Standalone so it opens in its own window with no address bar — an installed
        // application, not a browser tab someone might close by accident.
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        background_color: '#030712',
        theme_color: '#0e7490',
        categories: ['business', 'productivity'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          // Purpose 'maskable' is a separate entry, not an extra purpose on the icon above:
          // a platform that crops to a circle would otherwise cut into the crate.
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },

      workbox: {
        // Precache the shell only. Fonts are large but local, and the app is unusable
        // without them looking right on a device that has never been online.
        globPatterns: ['**/*.{js,css,html,woff,woff2,png,svg}'],
        // The build carries the PDF libraries, which are big and legitimately so.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,

        // THE IMPORTANT PART. Nothing under /api or /health is ever cached.
        //
        // This is not a performance decision. Stock levels, batches and request statuses are
        // the warehouse's live truth, held by the CMS server; a service worker answering
        // from cache would show a picker a quantity that no longer exists and let them
        // dispatch against it. The shell is cached so the app OPENS without the internet —
        // the data behind it always comes from the server, or does not come at all.
        navigateFallbackDenylist: [/^\/api/, /^\/health/, /^\/inbound/, /^\/sync/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /^\/(api|health|inbound|sync)/.test(url.pathname),
            handler: 'NetworkOnly',
          },
        ],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },

      devOptions: {
        // Off in dev: a service worker caching a hot-reloading build is a source of
        // confusing staleness, and the PWA behaviour is verified against a real build.
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:5100', changeOrigin: true },
      '/health': { target: 'http://localhost:5100', changeOrigin: true },
    },
    // A tunnel arrives with a hostname Vite has never seen, which it would otherwise
    // reject as a DNS-rebinding attempt. Dev server only.
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.io', '.ngrok.app'],
  },
});
