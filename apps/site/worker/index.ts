// These structural types describe only the binding methods this Worker uses. Keeping them
// here avoids adding the complete Workers runtime types to the static Astro application.
export interface WaitlistEnv {
  ASSETS: { fetch(request: Request): Promise<Response> }
  WAITLIST_DB: {
    prepare(sql: string): {
      bind(...values: (string | null)[]): { run(): Promise<unknown> }
    }
  }
  WAITLIST_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> }
  WAITLIST_DEVELOPMENT?: string
}

const maxBodyBytes = 4096
const consentTextVersion = '2026-11-30'
const successMessage = "Thanks. We'll email you when Hourmere Cloud launches."
const invalidMessage = 'Enter one valid email address and try again.'
const rateLimitedMessage = 'Too many attempts. Please try again in a minute.'
const unavailableMessage = "We couldn't save your request. Please try again later."
const fields = new Set(['email', 'hm_extra', 'locale', 'source'])
const sources = new Set(['pricing', 'cloud', 'faq'])

interface Submission {
  email: string
  hm_extra: string
  locale: string | null
  source: string | null
}

function allowedOrigin(request: Request, env: WaitlistEnv): boolean {
  const origin = request.headers.get('Origin')
  if (origin === 'https://hourmere.com' || origin === 'https://www.hourmere.com') return true
  if (env.WAITLIST_DEVELOPMENT !== 'true' || origin !== new URL(request.url).origin) return false
  const url = new URL(origin)
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  )
}

async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBodyBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

// Only a flat object of strings is supported. Reading the string tokens separately also
// rejects duplicate JSON keys, including keys written with JSON Unicode escapes.
function jsonEntries(body: string): [string, string][] | null {
  const stringToken = /"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y
  let position = 0
  const whitespace = () => {
    while (/[\t\n\r ]/.test(body[position] ?? '') && position < body.length) position++
  }
  const token = (): string | null => {
    whitespace()
    stringToken.lastIndex = position
    const match = stringToken.exec(body)
    if (!match) return null
    position = stringToken.lastIndex
    return JSON.parse(match[0]) as string
  }
  whitespace()
  if (body[position++] !== '{') return null
  whitespace()
  const entries: [string, string][] = []
  if (body[position] !== '}') {
    while (true) {
      const key = token()
      whitespace()
      if (key === null || body[position++] !== ':') return null
      const value = token()
      if (value === null) return null
      entries.push([key, value])
      whitespace()
      if (body[position] !== ',') break
      position++
    }
  }
  if (body[position++] !== '}') return null
  whitespace()
  return position === body.length ? entries : null
}

function validEmail(email: string): boolean {
  if (email.length > 254) return false
  const parts = email.split('@')
  if (parts.length !== 2) return false
  const [local = '', domain = ''] = parts
  if (
    local.length === 0 ||
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  ) {
    return false
  }
  const labels = domain.split('.')
  return (
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    /[a-z]/.test(labels.at(-1) ?? '')
  )
}

async function submission(request: Request): Promise<Submission | null> {
  const body = await boundedBody(request)
  if (!body) return null
  const contentType = request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
  let entries: [string, unknown][] | null
  if (contentType === 'application/json') {
    entries = jsonEntries(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } else if (contentType === 'application/x-www-form-urlencoded') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    if (/%(?![0-9a-f]{2})/i.test(text)) return null
    entries = [...new URLSearchParams(text)]
  } else if (contentType === 'multipart/form-data') {
    // Body size is checked before delegating multipart parsing to the runtime.
    const form = await new Response(body, {
      headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' },
    }).formData()
    entries = [...form]
  } else {
    return null
  }
  if (!entries) return null
  const values = new Map<string, string>()
  for (const [key, value] of entries) {
    if (!fields.has(key) || values.has(key) || typeof value !== 'string') return null
    values.set(key, value)
  }
  const rawEmail = values.get('email') ?? ''
  if (
    [...rawEmail].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    return null
  }
  const email = rawEmail.trim().toLowerCase()
  const hm_extra = values.get('hm_extra') ?? ''
  const locale = values.get('locale') ?? null
  const source = values.get('source') ?? null
  if (
    !validEmail(email) ||
    hm_extra.length > 1024 ||
    (locale !== null && locale !== 'en') ||
    (source !== null && !sources.has(source))
  ) {
    return null
  }
  return { email, hm_extra, locale, source }
}

function wantsJson(request: Request): boolean {
  return (
    request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ===
      'application/json' ||
    /(?:^|,)\s*application\/json(?:\s*;|\s*,|\s*$)/i.test(request.headers.get('Accept') ?? '')
  )
}

function reply(request: Request, status: number, message: string): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  })
  if (status === 429) headers.set('Retry-After', '60')
  if (wantsJson(request)) {
    headers.set('Content-Type', 'application/json; charset=utf-8')
    return new Response(JSON.stringify({ message }), { status, headers })
  }
  if (status === 200) {
    headers.set('Location', '/?waitlist=success#cloud-waitlist-success')
    return new Response(null, { status: 303, headers })
  }
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  )
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hourmere Cloud waitlist</title></head><body><main><h1>Hourmere Cloud waitlist</h1><p role="alert">${message}</p><p><a href="/#cloud-waitlist">Return to the waitlist form</a></p></main></body></html>`,
    { status, headers },
  )
}

async function rateLimitKey(request: Request, env: WaitlistEnv): Promise<string | null> {
  const ip = request.headers.get('CF-Connecting-IP')
  if (!ip && env.WAITLIST_DEVELOPMENT !== 'true') return null
  // Cloudflare supplies the client IP. A stable digest lets the binding own its window.
  // Only the digest reaches its transient counter: raw IPs never reach storage or logs.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`hourmere-waitlist:${ip ?? 'local'}`),
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function handleWaitlist(request: Request, env: WaitlistEnv): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/waitlist') {
    return env.ASSETS.fetch(request)
  }
  if (!allowedOrigin(request, env)) return reply(request, 400, invalidMessage)
  try {
    const key = await rateLimitKey(request, env)
    if (key === null) return reply(request, 503, unavailableMessage)
    if (!(await env.WAITLIST_RATE_LIMITER.limit({ key })).success) {
      return reply(request, 429, rateLimitedMessage)
    }
  } catch {
    return reply(request, 503, unavailableMessage)
  }
  let input: Submission | null
  try {
    input = await submission(request)
  } catch {
    return reply(request, 400, invalidMessage)
  }
  if (!input) return reply(request, 400, invalidMessage)
  if (input.hm_extra.length > 0) return reply(request, 200, successMessage)
  try {
    await env.WAITLIST_DB.prepare(
      'INSERT INTO waitlist (email, created_at, source, locale, consent_text_version) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING',
    )
      .bind(input.email, new Date().toISOString(), input.source, input.locale, consentTextVersion)
      .run()
  } catch {
    return reply(request, 503, unavailableMessage)
  }
  return reply(request, 200, successMessage)
}

export default { fetch: handleWaitlist }
