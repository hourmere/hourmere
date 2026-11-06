import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { offlineShell } from './pwa/build.ts'
import { pwaEnabled } from './pwa/config.ts'

export default defineConfig(({ mode }) => {
  // The API server's port: PORT from the environment or the repository's .env, as the server
  // itself reads it (default 3000). Only used here, never exposed to the app's code.
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  const env = loadEnv(mode, repoRoot, '')
  const apiPort = env.PORT || '3000'
  const enabled = pwaEnabled(env.VITE_PWA_ENABLED)

  return {
    envDir: repoRoot,
    define: { 'import.meta.env.VITE_PWA_ENABLED': JSON.stringify(String(enabled)) },
    plugins: [react(), offlineShell(enabled)],
    build: {
      // Lightning CSS rewrites container ranges despite this target; esbuild preserves
      // min-width queries for Safari 16.0–16.3, which ignores range syntax.
      cssMinify: 'esbuild',
      cssTarget: 'safari16',
    },
    server: {
      // Fixed: `npm run dev` points the API's PUBLIC_URL (sign-in links, cookies) at this port.
      port: 5173,
      strictPort: true,
      // The API runs separately in development (npm run dev starts both). The browser only
      // talks to this origin, so the session cookie is same-origin as in production. The
      // trailing slash keeps pages that merely start with "/api" (a booking page such as
      // /apiary/intro) with Vite. The server also serves
      // the page that emailed sign-in links open (not a page of this app).
      proxy: {
        '/api/': `http://localhost:${apiPort}`,
        '/booking/waitlist/verify': `http://localhost:${apiPort}`,
        '/booking/waitlist/remove': `http://localhost:${apiPort}`,
        '/sign-in/confirm': `http://localhost:${apiPort}`,
      },
    },
  }
})
