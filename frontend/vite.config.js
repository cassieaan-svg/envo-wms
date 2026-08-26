import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
