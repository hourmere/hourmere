// Booking emails end to end against a throwaway database: bookings made, moved and cancelled
// over REST and MCP queue their notification jobs in the booking's transaction, the job
// handler runs in-process with a capturing mailer, and the invitee's emailed link works
// wherever the API's manage token does.
import { randomBytes } from 'node:crypto'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { type Mailer, type MailMessage, type MailRefusal, MailRejectedError } from '@hourmere/mail'
import {
  BOOKING_NOTIFICATION_JOB,
  BookingNotificationPayload,
  bookingNotificationJob,
  bookingNotifier,
} from '@hourmere/notifications'
import type { BookingNotifier } from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest'
import { createApp } from './app.ts'
import { bookingTools } from './mcp/bookings.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { whoamiTool } from './mcp/whoami.ts'
import type { RateLimit } from './rate-limit.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { publicRoutes } from './routes/public.ts'

const serverUrl = process.env.DATABASE_URL
const PUBLIC_URL = 'http://localhost:3000'
// Sunday; the host's Berlin schedule offers Monday and Tuesday 09:00–17:00 (08:00Z–16:00Z).
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const plenty: RateLimit = { limit: 100_000, windowSeconds: 60 }
const limits = { page: plenty, slots: plenty, book: plenty, manage: plenty }
const NO_SUCH_USER: MailRefusal = { responseCode: 550, enhancedCode: '5.1.1', atRecipient: true }
const TOKEN_IN_LINK = /#token=([A-Za-z0-9_-]{43})&action=(?:reschedule|cancel)/g

interface Booking {
  id: string
  status: string
  start: string
  source: string
  rescheduledFromId: string | null
}
interface Booked {
  booking: Booking
  manageToken: string | null
  replayed?: boolean
}
type ToolResult = { isError?: boolean; content?: unknown; structuredContent?: unknown }

/** The tokens in an email's manage links (both links carry the same one). */
const tokensIn = (message: MailMessage | undefined) => [
  ...new Set([...(message?.text.matchAll(TOKEN_IN_LINK) ?? [])].map((m) => m[1] as string)),
]

/** The attached invitation's method, UID and sequence (the full format is tested in mail). */
function invitation(message: MailMessage | undefined) {
  const attachment = message?.attachments?.[0]
  if (!attachment) return undefined
  // RFC 5545 folds long lines with CRLF and a space.
  const lines = attachment.content.replace(/\r\n[ \t]/g, '').split('\r\n')
  const value = (name: string) =>
    lines.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1)
  return {
    contentType: attachment.contentType,
    method: value('METHOD'),
    uid: value('UID'),
    sequence: Number(value('SEQUENCE')),
  }
}

describe.skipIf(!serverUrl)('booking notifications over REST and MCP', () => {
  let testDb: TestDatabase
  let db: Db
  let authPool: pg.Pool
  let auth: Auth
  let jobs: ReturnType<typeof createJobs>
  let notify: BookingNotifier
  let app: ReturnType<typeof createApp>
  let hostEmail: string
  let hostKey: string
  let agentKey: string
  const handle = 'grace'

  // Everything the mailer was handed (also what it refused), and what it delivered.
  const attempted: MailMessage[] = []
  const sent: MailMessage[] = []
  const refuse = new Map<string, MailRefusal>()
  const mailer: Mailer = {
    async send(message) {
      attempted.push(message)
      const refusal = refuse.get(message.to)
      if (refusal) throw new MailRejectedError(refusal)
      sent.push(message)
    },
  }
  // Every response body (REST and MCP) and every log line, searched for secrets at the end.
  const responses: string[] = []
  const logs: string[] = []
  let consoleSpies: MockInstance[] = []

  const job = () =>
    bookingNotificationJob({
      db,
      mailer,
      publicUrl: PUBLIC_URL,
      now: () => NOW,
      log: (line) => logs.push(line),
    })

  function appWith(notifier: BookingNotifier) {
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: PUBLIC_URL,
      routes: [
        publicRoutes({ db, now: () => NOW, notify: notifier, rateLimits: limits }),
        bookingRoutes({ db, now: () => NOW, notify: notifier, rateLimits: limits }),
      ],
      mcp: mcpEndpoint({
        tools: [
          whoamiTool,
          ...bookingTools({ db, now: () => NOW, notify: notifier, rateLimits: limits }),
        ],
      }),
    })
  }

  beforeAll(async () => {
    consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      }),
    )
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    authPool = createAuthPool(testDb.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: PUBLIC_URL,
      secret: randomBytes(32).toString('base64'),
      mailer: { send: async () => {} },
      signup,
    })
    const f = createFixtures(db)
    const host = await f.host({ name: 'Grace Hopper', handle, timeZone: 'America/New_York' })
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      title: 'Intro call',
      location: { kind: 'link', url: 'https://meet.example.com/abc' },
      questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: false }],
    })
    hostEmail = (
      await db
        .selectFrom('auth.user')
        .select('email')
        .where('id', '=', host.userId)
        .executeTakeFirstOrThrow()
    ).email
    hostKey = (await auth.api.createApiKey({ body: { userId: host.userId, name: 'host' } })).key
    const agent = await f.host({ name: 'Assistant', handle: null })
    agentKey = (await auth.api.createApiKey({ body: { userId: agent.userId, name: 'agent' } })).key

    // Queues only: the tests run the handler themselves (drain), deterministically.
    jobs = createJobs({
      connectionString: testDb.url,
      definitions: [job()],
      work: false,
      migrate: true,
      log: (_level, line) => logs.push(line),
    })
    await jobs.start()
    notify = bookingNotifier(jobs)
    app = appWith(notify)
  })

  afterAll(async () => {
    await jobs?.stop()
    await authPool?.end()
    await testDb?.drop()
    for (const spy of consoleSpies) spy.mockRestore()
  })

  // --- REST and MCP clients that keep what they were answered ------------------------------

  async function rest(
    method: 'GET' | 'POST',
    path: string,
    { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {},
    a = app,
  ) {
    const res = await a.request(path, {
      method,
      headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    responses.push(text)
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> }
  }

  async function mcp(name: string, args: Record<string, unknown>, key = agentKey) {
    const client = new Client({ name: 'test-agent', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
        fetch: async (input, init) => app.request(input, init),
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    )
    try {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult
      responses.push(JSON.stringify(result))
      return result
    } finally {
      await client.close()
    }
  }
  const ok = <T>(result: ToolResult): T => {
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    return result.structuredContent as T
  }
  const toolError = (result: ToolResult) => {
    expect(result.isError).toBe(true)
    return JSON.parse((result.content as { text: string }[])[0]?.text ?? 'null') as {
      error: string
    }
  }

  const invitee = (email: string) => ({ name: 'Ada Lovelace', email, timeZone: 'Asia/Tokyo' })
  const book = (start: string, body: Record<string, unknown> = {}, headers = {}, a = app) =>
    rest(
      'POST',
      `/api/v1/public/${handle}/intro/bookings`,
      { body: { start, invitee: invitee('ada@example.com'), ...body }, headers },
      a,
    )
  const manage = (token: string, action?: 'cancel' | 'reschedule', body?: unknown) =>
    rest(action ? 'POST' : 'GET', `/api/v1/bookings/manage${action ? `/${action}` : ''}`, {
      body,
      headers: { 'x-manage-token': token },
    })

  // --- The queue -------------------------------------------------------------------------

  /** The notification jobs queued for a booking, by kind. */
  async function jobsFor(bookingId: string) {
    const { rows } = await testDb.pool.query<{ data: unknown; start_after: Date }>(
      `SELECT data, start_after FROM pgboss.job
        WHERE name = $1 AND data->>'bookingId' = $2 ORDER BY data->>'kind'`,
      [BOOKING_NOTIFICATION_JOB, bookingId],
    )
    return rows.map((r) => ({ data: r.data, startAfter: r.start_after.toISOString() }))
  }

  const handled = new Set<string>()
  /**
   * Runs the queued notification jobs not run yet that `which` selects (by default all but
   * reminders, which are not due yet), in the order they were queued, through the job's
   * own handler; returns the emails they sent.
   */
  async function drain(
    which: (p: { bookingId: string; kind: string }) => boolean = (p) => p.kind !== 'reminder',
  ): Promise<MailMessage[]> {
    const before = sent.length
    const { rows } = await testDb.pool.query<{ id: string; data: unknown }>(
      'SELECT id, data FROM pgboss.job WHERE name = $1 ORDER BY created_on, id',
      [BOOKING_NOTIFICATION_JOB],
    )
    const handler = job().handler
    for (const row of rows) {
      const payload = BookingNotificationPayload.parse(row.data)
      if (handled.has(row.id) || !which(payload)) continue
      handled.add(row.id)
      await handler(payload, { id: row.id, attempt: 1, signal: new AbortController().signal })
    }
    return sent.slice(before)
  }

  const to = (address: string) => (m: MailMessage) => m.to === address

  it('emails the host, the invitee and guests of a REST booking, once', async () => {
    const key = crypto.randomUUID()
    const created = await book(
      '2026-11-03T08:00:00Z',
      { guests: [{ name: 'Charles Babbage', email: 'charles@example.com' }] },
      { 'idempotency-key': key },
    )
    expect(created.status).toBe(201)
    const { booking, manageToken } = created.body as unknown as Booked
    // Queued with the booking: the email now, the reminder a day before. Ids only.
    expect(await jobsFor(booking.id)).toEqual([
      { data: { bookingId: booking.id, kind: 'confirmed' }, startAfter: expect.any(String) },
      {
        data: { bookingId: booking.id, kind: 'reminder' },
        startAfter: '2026-11-02T08:00:00.000Z',
      },
    ])

    const emails = await drain()
    expect(emails.map((m) => m.to)).toEqual([hostEmail, 'ada@example.com', 'charles@example.com'])
    for (const m of emails) {
      expect(invitation(m)).toEqual({
        contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
        method: 'REQUEST',
        uid: `${booking.id}@hourmere`,
        sequence: 0,
      })
    }
    const [toHost, toInvitee, toGuest] = emails
    expect(toHost?.subject).toMatch(/^New booking: Intro call with Ada Lovelace on /)
    expect(toInvitee?.subject).toMatch(/^Confirmed: Intro call with Grace Hopper on /)
    // Only the invitee's email has manage links, with a secret of its own.
    const [emailed] = tokensIn(toInvitee)
    expect(toInvitee?.text).toContain(`${PUBLIC_URL}/booking#token=${emailed}&action=reschedule`)
    expect(toInvitee?.text).toContain(`${PUBLIC_URL}/booking#token=${emailed}&action=cancel`)
    expect(emailed).not.toBe(manageToken)
    expect(tokensIn(toHost)).toEqual([])
    expect(tokensIn(toGuest)).toEqual([])

    // A retry with the same Idempotency-Key books nothing and queues nothing.
    const replay = await book(
      '2026-11-03T08:00:00Z',
      { guests: [{ name: 'Charles Babbage', email: 'charles@example.com' }] },
      { 'idempotency-key': key },
    )
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ booking: { id: booking.id }, manageToken: null })
    expect(await jobsFor(booking.id)).toHaveLength(2)
    expect(await drain()).toEqual([])
  })

  it('lets the emailed link show, reschedule and cancel over REST', async () => {
    const created = await book('2026-11-03T09:00:00Z')
    const { booking: original, manageToken } = created.body as unknown as Booked
    const [fromEmail] = tokensIn((await drain()).find(to('ada@example.com')))
    expect(fromEmail).toBeDefined()
    const emailed = fromEmail as string

    const shown = await manage(emailed)
    expect(shown).toMatchObject({ status: 200, body: { id: original.id, status: 'confirmed' } })

    const moved = await manage(emailed, 'reschedule', { start: '2026-11-03T13:00:00Z' })
    expect(moved.status).toBe(200)
    const { booking, manageToken: newToken } = moved.body as unknown as Booked
    expect(booking).toMatchObject({ rescheduledFromId: original.id, status: 'confirmed' })
    expect(newToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await jobsFor(booking.id)).toEqual([
      { data: { bookingId: booking.id, kind: 'reminder' }, startAfter: '2026-11-02T13:00:00.000Z' },
      { data: { bookingId: booking.id, kind: 'rescheduled' }, startAfter: expect.any(String) },
    ])

    // Both sides hear about it, as an update of the same calendar entry.
    const rescheduled = await drain()
    expect(rescheduled.map((m) => m.to)).toEqual([hostEmail, 'ada@example.com'])
    for (const m of rescheduled) {
      expect(m.subject).toMatch(/^Rescheduled: Intro call with /)
      expect(invitation(m)).toMatchObject({
        method: 'REQUEST',
        uid: `${original.id}@hourmere`,
        sequence: 1,
      })
    }
    const [fromNewEmail] = tokensIn(rescheduled[1])
    expect([emailed, manageToken, newToken]).not.toContain(fromNewEmail)
    // The old booking's reminder finds it replaced and sends nothing.
    expect(await drain((p) => p.bookingId === original.id && p.kind === 'reminder')).toEqual([])

    // The first email's link follows the meeting; the API's token stays with the old booking.
    expect(await manage(emailed)).toMatchObject({ body: { id: booking.id, status: 'confirmed' } })
    expect(await manage(manageToken as string)).toMatchObject({
      body: { id: original.id, status: 'cancelled' },
    })

    const cancelled = await manage(emailed, 'cancel', { reason: 'Something came up.' })
    expect(cancelled).toMatchObject({ status: 200, body: { id: booking.id, status: 'cancelled' } })
    const cancellations = await drain()
    expect(cancellations.map((m) => m.to)).toEqual([hostEmail, 'ada@example.com'])
    for (const m of cancellations) {
      expect(m.subject).toMatch(/^Cancelled: Intro call with /)
      expect(m.text).toContain('Something came up.')
      expect(tokensIn(m)).toEqual([])
      expect(invitation(m)).toEqual({
        contentType: 'text/calendar; method=CANCEL; charset=UTF-8',
        method: 'CANCEL',
        uid: `${original.id}@hourmere`,
        sequence: 2,
      })
    }
    // Still shown, but done: no reminder, no second cancellation.
    expect(await manage(fromNewEmail as string)).toMatchObject({
      status: 200,
      body: { id: booking.id, status: 'cancelled' },
    })
    expect(await manage(fromNewEmail as string, 'cancel')).toMatchObject({
      status: 409,
      body: { error: 'booking_cancelled' },
    })
    expect(await drain((p) => [original.id, booking.id].includes(p.bookingId))).toEqual([])
  })

  it('sends the same emails for MCP bookings, whose emailed link works with the tools', async () => {
    const key = crypto.randomUUID()
    const args = {
      handle,
      slug: 'intro',
      start: '2026-11-03T10:00:00Z',
      invitee: invitee('ada@example.com'),
      idempotencyKey: key,
    }
    const created = ok<Booked>(await mcp('create_booking', args))
    expect(created.booking.source).toBe('mcp')
    const confirmations = await drain()
    expect(confirmations.map((m) => m.subject)).toEqual([
      expect.stringMatching(/^New booking: Intro call with Ada Lovelace on /),
      expect.stringMatching(/^Confirmed: Intro call with Grace Hopper on /),
    ])
    expect(invitation(confirmations[0])).toMatchObject({ method: 'REQUEST', sequence: 0 })
    const [emailed] = tokensIn(confirmations[1])

    // A replayed call queues nothing more.
    const replay = ok<Booked>(await mcp('create_booking', args))
    expect(replay).toMatchObject({ replayed: true, manageToken: null })
    expect(await jobsFor(created.booking.id)).toHaveLength(2)
    expect(await drain()).toEqual([])

    const moved = ok<Booked>(
      await mcp('reschedule_booking', { manageToken: emailed, start: '2026-11-03T14:00:00Z' }),
    )
    expect(moved.booking).toMatchObject({ rescheduledFromId: created.booking.id, source: 'mcp' })
    const rescheduled = await drain()
    expect(rescheduled.map((m) => m.to)).toEqual([hostEmail, 'ada@example.com'])
    expect(invitation(rescheduled[1])).toMatchObject({
      uid: `${created.booking.id}@hourmere`,
      sequence: 1,
    })

    // The confirmation's link cancels the booking that replaced it.
    const cancelled = ok<Booking>(await mcp('cancel_booking', { manageToken: emailed }))
    expect(cancelled).toMatchObject({ id: moved.booking.id, status: 'cancelled' })
    const cancellations = await drain()
    expect(cancellations.map((m) => invitation(m)?.method)).toEqual(['CANCEL', 'CANCEL'])
    expect(toolError(await mcp('cancel_booking', { manageToken: emailed }))).toMatchObject({
      error: 'booking_cancelled',
    })
  })

  it('emails both sides when the host cancels, over REST and MCP', async () => {
    const asHost = { authorization: `Bearer ${hostKey}` }
    const first = (await book('2026-11-03T11:00:00Z')).body as unknown as Booked
    const second = (await book('2026-11-03T12:00:00Z')).body as unknown as Booked
    await drain()

    const byRest = await rest('POST', `/api/v1/bookings/${first.booking.id}/cancel`, {
      body: { reason: 'I am ill.' },
      headers: asHost,
    })
    expect(byRest).toMatchObject({ status: 200, body: { status: 'cancelled' } })
    const restEmails = await drain()
    expect(restEmails.map((m) => m.to)).toEqual([hostEmail, 'ada@example.com'])
    for (const m of restEmails) {
      expect(m.subject).toMatch(/^Cancelled: /)
      expect(m.text).toContain('I am ill.')
      expect(invitation(m)).toMatchObject({ method: 'CANCEL', uid: `${first.booking.id}@hourmere` })
    }

    ok(await mcp('cancel_booking', { bookingId: second.booking.id }, hostKey))
    const mcpEmails = await drain()
    expect(mcpEmails.map((m) => [m.to, invitation(m)?.method])).toEqual([
      [hostEmail, 'CANCEL'],
      ['ada@example.com', 'CANCEL'],
    ])
  })

  it('queues nothing for a booking that rolls back, and nothing a worker can see before the commit', async () => {
    let fail = true
    const seen: { bookingId: string; jobsOutside: number }[] = []
    const app2 = appWith(async (trx, event, now) => {
      await notify(trx, event, now)
      // Another connection, as a worker's, sees no job before the booking commits.
      const outside = await testDb.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND data->>'bookingId' = $2`,
        [BOOKING_NOTIFICATION_JOB, event.bookingId],
      )
      seen.push({ bookingId: event.bookingId, jobsOutside: outside.rows[0]?.n ?? -1 })
      if (fail) throw new Error('the booking fails after its jobs were queued')
    })

    const failed = await book('2026-11-03T15:00:00Z', {}, {}, app2)
    expect(failed).toMatchObject({ status: 500, body: { error: 'internal_error' } })
    const [rolledBack] = seen
    expect(rolledBack?.jobsOutside).toBe(0)
    expect(await jobsFor(rolledBack?.bookingId as string)).toEqual([])
    const { rows } = await testDb.pool.query('SELECT id FROM bookings WHERE id = $1', [
      rolledBack?.bookingId,
    ])
    expect(rows).toEqual([])

    fail = false
    const created = await book('2026-11-03T15:00:00Z', {}, {}, app2)
    expect(created.status).toBe(201)
    const { booking } = created.body as unknown as Booked
    expect(seen[1]).toEqual({ bookingId: booking.id, jobsOutside: 0 })
    expect((await jobsFor(booking.id)).map((j) => (j.data as { kind: string }).kind)).toEqual([
      'confirmed',
      'reminder',
    ])
    await drain()
  })

  it('never opens the booking with the secret of an email refused for good', async () => {
    refuse.set('nobody@example.com', NO_SUCH_USER)
    try {
      const created = await book('2026-11-02T10:00:00Z', {
        invitee: invitee('nobody@example.com'),
      })
      const { booking } = created.body as unknown as Booked
      const emails = await drain()
      expect(emails.map((m) => m.to)).toEqual([hostEmail])
      // The mailer was handed a link with a secret, but the server refused the address, so
      // its hash was never kept.
      const [refusedToken] = tokensIn(attempted.filter(to('nobody@example.com')).at(-1))
      expect(refusedToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const { rows } = await testDb.pool.query(
        `SELECT outcome, manage_token_hash FROM booking_notifications
          WHERE booking_id = $1 AND recipient LIKE 'attendee:%'`,
        [booking.id],
      )
      expect(rows).toEqual([{ outcome: 'rejected', manage_token_hash: null }])
      expect(await manage(refusedToken as string)).toMatchObject({
        status: 404,
        body: { error: 'booking_not_found' },
      })
      expect(
        toolError(await mcp('cancel_booking', { manageToken: refusedToken as string })),
      ).toMatchObject({ error: 'booking_not_found' })
      expect(logs.some((l) => l.includes('for good (550 5.1.1); not retrying'))).toBe(true)
    } finally {
      refuse.clear()
    }
  })

  it('never puts an emailed secret into a response or a log line', () => {
    const emailed = sent.flatMap(tokensIn)
    // Every invitee email above (confirmations and reschedules) carried one.
    expect(emailed.length).toBeGreaterThanOrEqual(6)
    expect(responses.length).toBeGreaterThan(20)
    for (const token of emailed) {
      expect(responses.filter((r) => r.includes(token))).toEqual([])
      expect(logs.filter((l) => l.includes(token))).toEqual([])
    }
  })
})
