// Response headers that tell browsers how to treat what the server sends: on every response,
// and a Content-Security-Policy and opener isolation on HTML pages.

import { isIP } from 'node:net'
import { embedParent } from '@hourmere/core/embed'
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'

/**
 * The web app's Content-Security-Policy, for HTML pages that bring no policy of their own.
 * The built app (apps/web/dist) is one module script and one stylesheet under /assets plus
 * icons at the root, with no inline script or style; Vite inlines the small SVG logos as
 * data: URLs, hence img-src data:. React sets style props through the CSSOM, which style-src
 * does not restrict. Sign-in with Google or Microsoft leaves the page by navigation, which
 * no directive here limits.
 *
 * Normal pages keep frame-ancestors 'none' and X-Frame-Options DENY. Only dedicated
 * public embed routes with a configured exact parent get a route-specific ancestor policy.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

/**
 * HSTS_MAX_AGE's default: a year, renewed by every response (scanners such as Mozilla's
 * Observatory want at least six months).
 */
export const DEFAULT_HSTS_MAX_AGE = 365 * 24 * 60 * 60

/**
 * The Strict-Transport-Security value for an instance at `publicUrl`, or undefined when it
 * should send none: only for https on a real host name. Browsers ignore it on IP addresses,
 * and on localhost it would hold every local port to https. Host only: includeSubDomains
 * would bind every host below PUBLIC_URL's, which for an instance at the apex (example.com)
 * is the whole domain, and preload goes further; the reverse proxy can add them. A max-age
 * of 0 tells browsers to forget an earlier policy.
 */
export function strictTransportSecurity(publicUrl: string, maxAge: number): string | undefined {
  const { protocol, hostname } = new URL(publicUrl)
  const local = hostname === 'localhost' || hostname.endsWith('.localhost')
  if (protocol !== 'https:' || local || isIP(hostname.replace(/^\[|\]$/g, ''))) return undefined
  return `max-age=${maxAge}`
}

/**
 * The invitee's manage page (/booking#token=…), like the sign-in confirm page, sends no
 * Referer at all. Its secret is in the fragment, which no Referer carries anyway; this keeps
 * that true if anything secret ever ends up in its path or query.
 */
const NO_REFERRER_PAGES = /^\/booking(\/|$)/i

const HTML = /^text\/html/i

export interface SecurityHeadersOptions {
  /** The Strict-Transport-Security value (see strictTransportSecurity); none if undefined. */
  hsts?: string | undefined
  embedOrigins?: readonly string[] | undefined
}

/**
 * Adds the headers to every response, errors and 404s included, once it is made. Every
 * response gets nosniff and, when given, HSTS, whatever it says itself; it also gets
 * X-Frame-Options DENY and Referrer-Policy strict-origin-when-cross-origin (no-referrer on the
 * manage page) unless it has a value of its own, which the route set on purpose (the sign-in
 * confirm page's no-referrer, for instance). HTML pages also get APP_CSP and
 * Cross-Origin-Opener-Policy same-origin, likewise unless they have their own (the confirm
 * page's stricter CSP). An empty value counts as none.
 */
export function securityHeaders({
  hsts,
  embedOrigins = [],
}: SecurityHeadersOptions = {}): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    await next()
    let headers = c.res.headers
    try {
      headers.set('X-Content-Type-Options', 'nosniff')
    } catch {
      // Immutable headers, as Response.redirect() and fetch() make: copy the response.
      c.res = new Response(c.res.body, c.res)
      headers = c.res.headers
      headers.set('X-Content-Type-Options', 'nosniff')
    }
    const setDefault = (name: string, value: string) => {
      if (!headers.get(name)?.trim()) headers.set(name, value)
    }
    if (hsts) headers.set('Strict-Transport-Security', hsts)
    setDefault('X-Frame-Options', 'DENY')
    if (HTML.test(headers.get('content-type') ?? '')) {
      const parent = embedParent(new URL(c.req.url), embedOrigins)
      if (parent) {
        headers.delete('X-Frame-Options')
        headers.set(
          'Content-Security-Policy',
          APP_CSP.replace("frame-ancestors 'none'", `frame-ancestors ${parent}`),
        )
        headers.set('Referrer-Policy', 'no-referrer')
      } else setDefault('Content-Security-Policy', APP_CSP)
      setDefault('Cross-Origin-Opener-Policy', 'same-origin')
      if (NO_REFERRER_PAGES.test(c.req.path)) setDefault('Referrer-Policy', 'no-referrer')
    }
    setDefault('Referrer-Policy', 'strict-origin-when-cross-origin')
  })
}
