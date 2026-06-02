import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Emit to the repo-root /dist so Netlify (which publishes root "dist") finds it.
    outDir: '../dist',
    emptyOutDir: true,
  },
})
