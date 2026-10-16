import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // Fixed: `npm run dev` points the API's PUBLIC_URL (sign-in links, cookies) at this port.
    port: 5173,
    strictPort: true,
    // The API runs separately in development (npm run dev starts both). The browser only
    // talks to this origin, so the session cookie is same-origin as in production. The server
    // also serves the page that emailed sign-in links open.
    proxy: { '/api': 'http://localhost:3000', '/sign-in/confirm': 'http://localhost:3000' },
  },
})
