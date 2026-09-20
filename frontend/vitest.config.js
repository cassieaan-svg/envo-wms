import { defineConfig } from 'vitest/config'

// Separate from vite.config.js on purpose: that one carries the PWA plugin (a build
// concern), and mixing the two just to share a few lines isn't worth coupling test
// runs to production-build config.
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.js'],
  },
})
