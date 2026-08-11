import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The proxy exists for one case: reaching the app over a tunnel (Cloudflare, ngrok) for a
// demo. The browser is then on someone else's machine, where `localhost:5100` is their PC
// and not the store server, so the API has to arrive on the same origin as the page and
// be forwarded from here. Set VITE_API_URL= (empty) to make the client use same-origin
// paths and go through this proxy.
//
// It changes nothing for the normal LAN deployment, which builds with an absolute
// VITE_API_URL and never runs the dev server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:5100', changeOrigin: true },
    },
    // A tunnel arrives with a hostname Vite has never seen, which it would otherwise
    // reject as a DNS-rebinding attempt. Dev server only.
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.io', '.ngrok.app'],
  },
});
