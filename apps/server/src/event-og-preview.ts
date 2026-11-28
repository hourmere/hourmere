import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { isPublicTeamSlug, isReservedName } from '@hourmere/core'
import { acceptLanguage, type InterfaceLanguage } from '@hourmere/core/language'
import type { Db } from '@hourmere/db'
import { getPublicEventOgImage } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import { etag } from 'hono/etag'
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, type OgImageInputs, renderOgImage } from './og-image.ts'
import { createRateLimiter, PUBLIC_RATE_LIMITS, rateLimit } from './rate-limit.ts'
import { isPublicRoutingContinuationPage } from './routing-form-privacy.ts'

export const OG_IMAGE_PREFIX = '/api/og'

declare module 'hono' {
  interface ContextVariableMap {
    /** This request has a validated public event image address. */
    isOgEventAddress?: true
  }
}

// Shared HTTP caches revalidate eligibility before reusing a previously public image.
const CACHE_CONTROL = 'public, max-age=0, must-revalidate'
const CACHE_ENTRIES = 128
const CACHE_BYTES = 8 * 1024 * 1024
const CONCURRENT_RENDERS = 2

interface Preview {
  png: Uint8Array<ArrayBuffer>
  etag: string
}

async function renderPreview(key: string, inputs?: OgImageInputs): Promise<Preview> {
  const png = Uint8Array.from(await renderOgImage(inputs))
  const digest = createHash('sha256').update(key).update(png).digest('hex')
  return { png, etag: `"${digest}"` }
}

function createPreviewCache() {
  const completed = new Map<string, Preview>()
  const pending = new Map<string, Promise<Preview>>()
  let bytes = 0
  let generic: Promise<Preview> | undefined

  return function preview(inputs: OgImageInputs | undefined): Promise<Preview> | undefined {
    // Keep the generic response available independently of the custom-render limit and LRU.
    if (!inputs) {
      generic ??= renderPreview('generic').catch((error: unknown) => {
        generic = undefined
        throw error
      })
      return generic
    }
    const key = createHash('sha256')
      .update(
        JSON.stringify([inputs.title, inputs.durationMinutes, inputs.name, inputs.primaryColor]),
      )
      .digest('hex')
    const cached = completed.get(key)
    if (cached) {
      completed.delete(key)
      completed.set(key, cached)
      return Promise.resolve(cached)
    }
    const running = pending.get(key)
    if (running) return running
    if (pending.size >= CONCURRENT_RENDERS) return undefined

    const rendering = renderPreview(key, inputs)
      .then((result) => {
        completed.set(key, result)
        bytes += result.png.byteLength
        for (const [oldest, entry] of completed) {
          if (completed.size <= CACHE_ENTRIES && bytes <= CACHE_BYTES) break
          completed.delete(oldest)
          bytes -= entry.png.byteLength
        }
        return result
      })
      .finally(() => pending.delete(key))
    pending.set(key, rendering)
    return rendering
  }
}

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/i
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i
const POLL_PAGES = new Set(['voter', 'recover', 'reminder-opt-out'])

function eventAddress(scope: string, handle: string, slug: string) {
  if (!SLUG.test(slug)) return undefined
  if (scope === 'team' && isPublicTeamSlug(handle))
    return { kind: 'team' as const, handle, slug: slug.toLowerCase() }
  if (scope !== 'event' || !HANDLE.test(handle) || isReservedName(handle)) return undefined
  const personalHandle = handle.toLowerCase()
  const personalSlug = slug.toLowerCase()
  // Legacy handles can coexist with explicit, higher-priority private SPA routes.
  if (personalHandle === 'poll' && POLL_PAGES.has(personalSlug)) return undefined
  if (isPublicRoutingContinuationPage(`/${personalHandle}/${personalSlug}`)) return undefined
  return { kind: 'personal' as const, handle: personalHandle, slug: personalSlug }
}

export function mountEventOgImages(app: OpenAPIHono, db: Db, scimResourcesEnabled: boolean) {
  const preview = createPreviewCache()
  const limit = rateLimit(createRateLimiter(PUBLIC_RATE_LIMITS.ogImage))
  app.get(`${OG_IMAGE_PREFIX}/:scope/:handle/:slug`, limit, etag(), async (c) => {
    const { scope, handle, slug } = c.req.param()
    if (scope !== 'event' && scope !== 'team') return c.notFound()
    const address = eventAddress(scope, handle, slug)
    if (address) c.set('isOgEventAddress', true)
    // Recheck current visibility even when the render is cached or the client sends an ETag.
    const inputs = address && (await getPublicEventOgImage(db, address, scimResourcesEnabled))
    try {
      const response = await preview(inputs)
      if (response) {
        return c.body(response.png, 200, {
          'Cache-Control': CACHE_CONTROL,
          'Content-Type': 'image/png',
          ETag: response.etag,
        })
      }
    } catch {
      // Native text diagnostics can include user-supplied content.
      console.error('Open Graph image rendering failed')
    }
    c.header('Retry-After', '1')
    return c.json({ error: 'service_unavailable' }, 503)
  })
}

const imageAlt: Record<InterfaceLanguage, string> = {
  en: 'Booking page link preview',
  'zh-CN': '预约页面链接预览',
  de: 'Linkvorschau der Buchungsseite',
  es: 'Vista previa del enlace de reserva',
  fr: 'Aperçu du lien de réservation',
  'pt-BR': 'Prévia do link da página de agendamento',
}

/** Adds crawler-visible metadata only to the public event SPA fallback. */
export function bookingPreviewMetadata(webDist: string, publicUrl: string): MiddlewareHandler {
  const indexPath = join(webDist, 'index.html')
  return async (c, next) => {
    const path = new URL(c.req.url).pathname
    // Legitimate ASCII segments can be percent-encoded. Decode per segment so an encoded
    // slash cannot become a path separator, and ignore malformed or oversized paths.
    if (path.length > 400) return next()
    let parts: string[]
    try {
      parts = path.slice(1).replace(/\/$/, '').split('/').map(decodeURIComponent)
    } catch {
      return next()
    }
    const [first = '', second = '', third = ''] = parts
    const address =
      parts.length === 3 && first.toLowerCase() === 'team'
        ? eventAddress('team', second, third)
        : parts.length === 2
          ? eventAddress('event', first, second)
          : undefined
    if (!address) return next()

    const html = await readFile(indexPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (html === undefined) return next()

    const scope = address.kind === 'team' ? 'team' : 'event'
    const imageUrl = new URL(
      `${OG_IMAGE_PREFIX}/${scope}/${address.handle}/${address.slug}`,
      publicUrl,
    )
    const alt = imageAlt[acceptLanguage(c.req.header('Accept-Language'), 'public')]
    // The URL has a configured origin and only validated ASCII address segments. Alt is fixed copy.
    const tags = [
      `<meta property="og:image" content="${imageUrl.href}" />`,
      `<meta property="og:image:width" content="${OG_IMAGE_WIDTH}" />`,
      `<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}" />`,
      `<meta property="og:image:alt" content="${alt}" />`,
      '<meta name="twitter:card" content="summary_large_image" />',
    ].join('\n    ')
    c.header('Vary', 'Accept-Language', { append: true })
    return c.html(html.replace(/<meta name="twitter:card" content="summary"\s*\/?>/, () => tags))
  }
}
