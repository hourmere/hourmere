import { serveStatic } from '@hono/node-server/serve-static'
import type { MiddlewareHandler } from 'hono'

/** Stable PWA URLs must revalidate and must never fall through to the SPA. */
export function pwaStatic(root: string): MiddlewareHandler {
  const serve = serveStatic({ root })
  return async (c) => {
    const response = await serve(c, async () => {
      c.res = c.text('Not found', 404)
    })
    if (response) c.res = response
    c.res.headers.set('Cache-Control', 'no-cache')
    if (c.res.status === 200) {
      if (c.req.path === '/app/sw.js') {
        c.res.headers.set('Content-Type', 'text/javascript; charset=utf-8')
        // Never broaden this to /: public booking and capability pages are outside scope.
        c.res.headers.set('Service-Worker-Allowed', '/app/')
      } else {
        c.res.headers.set('Content-Type', 'application/manifest+json; charset=utf-8')
      }
    }
    return c.res
  }
}
