// Response headers that tell browsers how to treat what the server sends: on every response,
// and a Content-Security-Policy and opener isolation on HTML pages.
import { isIP } from 'node:net'
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
 * frame-ancestors 'none' (and X-Frame-Options: DENY below) keep every page out of frames.
 * When public booking pages become embeddable, decide framing per route in securityHeaders:
 * those pages get frame-ancestors with the allowed origins and no X-Frame-Options (which
 * cannot express an allow list); everything else keeps 'none' and DENY.
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

/** HSTS_MAX_AGE's default: 180 days, renewed by every response. */
export const DEFAULT_HSTS_MAX_AGE = 180 * 24 * 60 * 60

/**
 * The Strict-Transport-Security value for an instance at `publicUrl`, or undefined when it
 * should send none: only for https on a real host name. Browsers ignore it on IP addresses,
 * and on localhost it would hold every local port to https. Without includeSubDomains or
 * preload, which would bind other hosts of the domain: the reverse proxy can add those.
 * A max-age of 0 tells browsers to forget an earlier policy.
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
const NO_REFERRER_PAGES = /^\/booking(\/|$)/

const HTML = /^text\/html/i

export interface SecurityHeadersOptions {
  /** The Strict-Transport-Security value (see strictTransportSecurity); none if undefined. */
  hsts?: string | undefined
}

/**
 * Adds the headers to every response, errors and 404s included, once it is made. A header the
 * response already has is left alone: the route set it on purpose (the sign-in confirm page's
 * own CSP and no-referrer, for instance). Every response: nosniff, X-Frame-Options DENY,
 * Referrer-Policy strict-origin-when-cross-origin (no-referrer on the manage page) and, when
 * given, HSTS. HTML pages also get APP_CSP and Cross-Origin-Opener-Policy same-origin.
 */
export function securityHeaders({ hsts }: SecurityHeadersOptions = {}): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    await next()
    const headers = c.res.headers
    const setDefault = (name: string, value: string) => {
      if (!headers.has(name)) headers.set(name, value)
    }
    setDefault('X-Content-Type-Options', 'nosniff')
    setDefault('X-Frame-Options', 'DENY')
    if (hsts) setDefault('Strict-Transport-Security', hsts)
    if (HTML.test(headers.get('content-type') ?? '')) {
      setDefault('Content-Security-Policy', APP_CSP)
      setDefault('Cross-Origin-Opener-Policy', 'same-origin')
      if (NO_REFERRER_PAGES.test(c.req.path)) setDefault('Referrer-Policy', 'no-referrer')
    }
    setDefault('Referrer-Policy', 'strict-origin-when-cross-origin')
  })
}
