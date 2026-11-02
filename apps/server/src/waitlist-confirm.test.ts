import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  DomainError,
  joinWaitlist,
  mintWaitlistManagementToken,
  openWaitlistVerificationOutbox,
  removeWaitlist,
  verifyWaitlist,
  type WaitlistContext,
} from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { inlineAsset } from './sign-in-confirm-testing.ts'
import {
  registerWaitlistConfirmation,
  WAITLIST_REMOVE_PATH,
  WAITLIST_VERIFY_PATH,
} from './waitlist-confirm.ts'

const origin = 'https://schedule.example'
const token = `00000000-0000-4000-8000-000000000001.${'t'.repeat(43)}`
const headers = {
  Origin: origin,
  'Sec-Fetch-Site': 'same-origin',
  'Content-Type': 'application/json',
}
function fixture(register = registerWaitlistConfirmation) {
  const verify = vi.fn(async (_token: string) => ({}))
  const remove = vi.fn(async (_token: string) => ({}))
  const app = new Hono()
  register(app, { publicUrl: origin, verify, remove })
  return { app, verify, remove }
}
const post = (app: Hono, path: string, value = token, extraHeaders = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify({ token: value }),
  })

async function sourceCopy(
  before: string,
  after: string,
): Promise<typeof registerWaitlistConfirmation> {
  const location = new URL('./waitlist-confirm.ts', import.meta.url)
  const original = await readFile(location, 'utf8')
  expect(original.includes(before), 'mutation matches the real transport protection').toBe(true)
  const source = stripTypeScriptTypes(original.replace(before, after)).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`))
    .registerWaitlistConfirmation
}

describe('waitlist confirmation transports', () => {
  async function assertHandleRoutes(register = registerWaitlistConfirmation) {
    const { app, verify, remove } = fixture(register)
    app.get('/:handle/:slug', (c) =>
      c.json({ handle: c.req.param('handle'), slug: c.req.param('slug') }),
    )
    for (const slug of ['verify', 'remove']) {
      const response = await app.request(`/waitlist/${slug}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toEqual({ handle: 'waitlist', slug })
    }
    expect(verify).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  }

  it('keeps existing waitlist handle event pages routable', async () => {
    await assertHandleRoutes()
  })

  it.each(['verify', 'remove'])(
    'detects confirmation routing that shadows the existing waitlist/%s event',
    async (mode) => {
      const copied = await sourceCopy(`'/booking/waitlist/${mode}'`, `'/waitlist/${mode}'`)
      await expect(assertHandleRoutes(copied)).rejects.toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    },
  )

  it.each([WAITLIST_VERIFY_PATH, WAITLIST_REMOVE_PATH])(
    'keeps GET/HEAD scanner visits read-only and private at %s',
    async (path) => {
      const { app, verify, remove } = fixture()
      for (const method of ['GET', 'HEAD']) {
        const response = await app.request(path, { method })
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
        expect(response.headers.get('x-frame-options')).toBe('DENY')
        expect(response.headers.has('set-cookie')).toBe(false)
        if (method === 'HEAD') expect(await response.text()).toBe('')
        else {
          const html = await response.text()
          const csp = response.headers.get('content-security-policy') ?? ''
          for (const tag of ['script', 'style'] as const) {
            const digest = createHash('sha256').update(inlineAsset(html, tag)).digest('base64')
            expect(csp).toContain(`'sha256-${digest}'`)
          }
          expect(csp).toContain("default-src 'none'")
          expect(csp).toContain("connect-src 'self'")
          expect(csp).not.toMatch(/unsafe-inline|https?:/)
          expect(html).not.toMatch(/<(?:script|link|img)[^>]*(?:src|href)=/i)
        }
      }
      expect(verify).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
    },
  )

  it('consumes a capability only through strict explicit same-origin JSON POST', async () => {
    const { app, verify, remove } = fixture()
    const verified = await post(app, WAITLIST_VERIFY_PATH)
    expect(verified.status).toBe(200)
    expect(await verified.json()).toEqual({ verified: true })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(verify.mock.calls[0]?.[0] === token).toBe(true)
    const removed = await post(app, WAITLIST_REMOVE_PATH)
    expect(await removed.json()).toEqual({ removed: true })
    expect(remove.mock.calls[0]?.[0] === token).toBe(true)
    expect(removed.headers.get('cache-control')).toBe('no-store')
    expect(removed.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it.each([
    { Origin: 'https://other.example' },
    { Origin: 'null' },
    { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
    { 'Sec-Fetch-Site': 'none' },
  ])('refuses unsafe-origin confirmation before service invocation (%j)', async (extraHeaders) => {
    const { app, verify, remove } = fixture()
    for (const path of [WAITLIST_VERIFY_PATH, WAITLIST_REMOVE_PATH]) {
      const response = await post(app, path, token, extraHeaders)
      expect(response.status).toBe(403)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(verify).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('rejects query capabilities, non-JSON, extra input, malformed JSON and invalid tokens safely', async () => {
    const { app, verify } = fixture()
    const query = await post(app, `${WAITLIST_VERIFY_PATH}?token=untrusted`)
    expect(query.status).toBe(400)
    const media = await post(app, WAITLIST_VERIFY_PATH, token, { 'Content-Type': 'text/plain' })
    expect(media.status).toBe(415)
    for (const body of ['{', JSON.stringify({ token, email: 'untrusted@example.test' }), '{}']) {
      const response = await app.request(WAITLIST_VERIFY_PATH, { method: 'POST', headers, body })
      expect([400, 404]).toContain(response.status)
      expect((await response.text()).includes(token)).toBe(false)
    }
    expect((await post(app, WAITLIST_VERIFY_PATH, 'invalid')).status).toBe(404)
    expect(verify).not.toHaveBeenCalled()
  })

  it('bounds declared and streamed request bodies before a service runs', async () => {
    const { app, verify } = fixture()
    const declared = await post(app, WAITLIST_VERIFY_PATH, token, { 'Content-Length': '1025' })
    expect(declared.status).toBe(413)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ token })))
        controller.enqueue(new TextEncoder().encode(' '.repeat(1100)))
        controller.close()
      },
    })
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers,
      body,
      duplex: 'half',
    }
    const streamed = await app.request(WAITLIST_VERIFY_PATH, init)
    expect(streamed.status).toBe(413)
    expect(verify).not.toHaveBeenCalled()
  })

  it('shares the 30/minute edge limit between verification and removal, refusing before a body read', async () => {
    const { app, verify } = fixture()
    for (let n = 0; n < 30; n++) expect((await app.request(WAITLIST_REMOVE_PATH)).status).toBe(200)
    const response = await post(app, WAITLIST_VERIFY_PATH)
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(verify).not.toHaveBeenCalled()
  })

  it('never logs capabilities or exposes service error details in the response', async () => {
    const { app, verify } = fixture()
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    try {
      verify.mockRejectedValueOnce(new Error(`driver echoed ${token}`))
      const failed = await post(app, WAITLIST_VERIFY_PATH)
      expect(failed.status).toBe(500)
      expect(await failed.json()).toEqual({ error: 'internal_error' })
      verify.mockRejectedValueOnce(new DomainError('not_found', 'invalid_waitlist_token'))
      const invalid = await post(app, WAITLIST_VERIFY_PATH)
      expect(invalid.status).toBe(404)
      expect(await invalid.json()).toEqual({ error: 'invalid_waitlist_token' })
      expect(
        spies
          .flatMap((spy) => spy.mock.calls)
          .flat()
          .join(' ')
          .includes(token),
      ).toBe(false)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it.each([
    ["c.header('Cache-Control', 'no-store')", '', 'cache-control', 'no-store'],
    ["c.header('Referrer-Policy', 'no-referrer')", '', 'referrer-policy', 'no-referrer'],
  ])(
    'detects a removed %s with an actual assertion failure',
    async (before, after, header, expected) => {
      const { app } = fixture(await sourceCopy(before, after))
      const response = await app.request(WAITLIST_VERIFY_PATH)
      expect(() => expect(response.headers.get(header)).toBe(expected)).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    },
  )

  it('detects scanner activation from a mutated source copy', async () => {
    const { app, verify } = fixture(
      await sourceCopy(
        "app.on(['GET', 'HEAD'], path, (c) => confirmationPage(c, mode))",
        "app.on(['GET', 'HEAD'], path, (c) => { void deps.verify('scanner'); return confirmationPage(c, mode) })",
      ),
    )
    await app.request(WAITLIST_VERIFY_PATH)
    expect(() => expect(verify).not.toHaveBeenCalled()).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it.each([
    ["c.req.header('Origin') !== origin", 'false', { Origin: 'https://other.example' }],
    ["(site !== undefined && site !== 'same-origin')", 'false', { 'Sec-Fetch-Site': 'cross-site' }],
  ])(
    'detects a removed origin guard with an actual assertion failure',
    async (before, after, extraHeaders) => {
      const { app } = fixture(await sourceCopy(before, after))
      const response = await post(app, WAITLIST_VERIFY_PATH, token, extraHeaders)
      expect(() => expect(response.status).toBe(403)).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    },
  )

  it('detects removal of the shared edge limit', async () => {
    const { app } = fixture(
      await sourceCopy(
        'app.use(path, clientIp(deps.trustedProxies ?? []), limiter)',
        'app.use(path, clientIp(deps.trustedProxies ?? []))',
      ),
    )
    for (let n = 0; n < 30; n++) await app.request(WAITLIST_REMOVE_PATH)
    const response = await post(app, WAITLIST_VERIFY_PATH)
    expect(() => expect(response.status).toBe(429)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects accepting query capabilities from a mutated source copy', async () => {
    const { app } = fixture(
      await sourceCopy(
        "if (new URL(c.req.url).search) return c.json({ error: 'invalid_request' }, 400)",
        '',
      ),
    )
    const response = await post(app, `${WAITLIST_VERIFY_PATH}?token=untrusted`)
    expect(() => expect(response.status).toBe(400)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('detects removal of streamed body bound', async () => {
    const { app } = fixture(await sourceCopy('if (length > MAX_BODY_BYTES)', 'if (false)'))
    const response = await app.request(WAITLIST_VERIFY_PATH, {
      method: 'POST',
      headers,
      body: `${JSON.stringify({ token })}${' '.repeat(1100)}`,
    })
    expect(() => expect(response.status).toBe(413)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})

const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('waitlist mail confirmations with real PostgreSQL', () => {
  let database: TestDatabase
  let db: Db
  let ctx: WaitlistContext
  let clock = Temporal.Instant.from('2026-11-01T12:00:00Z')
  beforeAll(async () => {
    database = await createTestDatabase(serverUrl as string)
    db = createDb(database.pool)
    ctx = { db, publicUrl: origin, secret: 'synthetic-confirmation-secret', now: () => clock }
  })
  afterAll(async () => {
    await database?.drop()
  })

  async function pendingEntry() {
    const fixtures = createFixtures(db)
    const host = await fixtures.host()
    const eventId = await fixtures.eventType(host.organizationId, host.userId)
    await db
      .updateTable('event_types')
      .set({ waitlist_enabled: true })
      .where('id', '=', eventId)
      .execute()
    const event = await db
      .selectFrom('event_types')
      .select('slug')
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow()
    await joinWaitlist(ctx, {
      handle: host.handle,
      slug: event.slug,
      email: `${eventId}@example.test`,
      consent: true,
      preferredWindow: {
        start: clock.add({ hours: 12 }).toString(),
        end: clock.add({ hours: 72 }).toString(),
        timeZone: 'Europe/Berlin',
      },
    })
    const entry = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('event_type_id', '=', eventId)
      .executeTakeFirstOrThrow()
    const outbox = await db
      .selectFrom('waitlist_verification_outbox')
      .selectAll()
      .where('entry_id', '=', entry.id)
      .executeTakeFirstOrThrow()
    const payload = openWaitlistVerificationOutbox(ctx, outbox)
    if (!payload) throw new Error('Expected synthetic verification payload')
    const management = await db
      .transaction()
      .execute((trx) =>
        mintWaitlistManagementToken(trx, entry.id, new Date(clock.epochMilliseconds)),
      )
    const app = new Hono()
    registerWaitlistConfirmation(app, {
      publicUrl: origin,
      verify: (capability) => verifyWaitlist(ctx, { token: capability }),
      remove: (capability) => removeWaitlist(ctx, { token: capability }),
    })
    return { app, entryId: entry.id, verification: payload.verificationToken, management }
  }

  it('scanner GET/HEAD cannot activate; explicit POST activates and self-removal erases contacts idempotently', async () => {
    const entry = await pendingEntry()
    await entry.app.request(WAITLIST_VERIFY_PATH)
    await entry.app.request(WAITLIST_REMOVE_PATH, { method: 'HEAD' })
    const before = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('id', '=', entry.entryId)
      .executeTakeFirstOrThrow()
    expect(before.status).toBe('pending_verification')
    expect((await post(entry.app, WAITLIST_VERIFY_PATH, entry.management)).status).toBe(404)
    expect((await post(entry.app, WAITLIST_VERIFY_PATH, entry.verification)).status).toBe(200)
    const verified = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('id', '=', entry.entryId)
      .executeTakeFirstOrThrow()
    expect(verified.status).toBe('active')
    expect((await post(entry.app, WAITLIST_VERIFY_PATH, entry.verification)).status).toBe(200)
    expect((await post(entry.app, WAITLIST_REMOVE_PATH, entry.verification)).status).toBe(404)
    for (let n = 0; n < 2; n++)
      expect((await post(entry.app, WAITLIST_REMOVE_PATH, entry.management)).status).toBe(200)
    const removed = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('id', '=', entry.entryId)
      .executeTakeFirstOrThrow()
    expect(removed.status).toBe('removed')
    expect([
      removed.email,
      removed.name,
      removed.window_start,
      removed.window_end,
      removed.time_zone,
      removed.locale,
    ]).toEqual([null, null, null, null, null, null])
    expect((await post(entry.app, WAITLIST_VERIFY_PATH, entry.verification)).status).toBe(404)
  })

  it('rejects verification at the exact thirty-minute expiry without activating or sending mail', async () => {
    const entry = await pendingEntry()
    clock = clock.add({ minutes: 30 })
    const response = await post(entry.app, WAITLIST_VERIFY_PATH, entry.verification)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'invalid_waitlist_token' })
    const stored = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('id', '=', entry.entryId)
      .executeTakeFirstOrThrow()
    expect(stored.status).toBe('pending_verification')
    expect(stored.verified_at).toBeNull()
  })
})

describe('confirmation catalogue script escaping', () => {
  it('keeps tag-shaped translation text inside JSON and detects omission in a source copy', async () => {
    const source = await readFile(new URL('./waitlist-confirm.ts', import.meta.url), 'utf8')
    const start = source.indexOf('const CATALOGUES_JSON =')
    const fragment = source.slice(start, source.indexOf('const SCRIPT =', start))
    const words = { en: { title: '</script><script>untrusted</script>' } }
    const assertEscaped = (code: string) => {
      const serialized = new Function(
        'waitlistConfirmationCatalogues',
        `${code}; return CATALOGUES_JSON`,
      )(words) as string
      expect(serialized.includes('<')).toBe(false)
      expect(JSON.parse(serialized)).toEqual(words)
    }
    assertEscaped(fragment)
    const before = String.raw`.replaceAll('<', '\\u003c')`
    expect(fragment.includes(before), 'mutation matches real script serialization').toBe(true)
    expect(() => assertEscaped(fragment.replace(before, ''))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
