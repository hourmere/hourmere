// Follow a hidden event through the recipient lifecycle with real HTTP/database services
// and a capturing mailer. A capability must never disclose the reusable booking address.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { Mailer, MailMessage } from '@hourmere/mail'
import { sendBookingNotification } from '@hourmere/notifications'
import type * as Bookings from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { oneTimeBookingRoutes } from './routes/one-time-bookings.ts'
import { publicRoutes } from './routes/public.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const PUBLIC_URL = 'https://calendar.example.test'
const plenty = { limit: 100_000, windowSeconds: 60 }
const invitee = { name: 'Recipient', email: 'recipient@example.test', timeZone: 'UTC' }
const bookingKeys = [
  'id',
  'eventTypeId',
  'status',
  'start',
  'end',
  'title',
  'location',
  'responses',
  'attendees',
  'rescheduledFromId',
  'cancelledAt',
  'cancelReason',
  'source',
  'createdAt',
]
const keys = (value: object) => Object.keys(value).sort()

/** Native imports of an isolated source copy keep production files untouched. */
async function bookingSourceCopy(change?: readonly [string, string]): Promise<typeof Bookings> {
  const location = new URL('../../../packages/scheduling/src/bookings.ts', import.meta.url)
  const original = readFileSync(location, 'utf8')
  if (change) expect(original.includes(change[0]), 'mutation must match source').toBe(true)
  const source = stripTypeScriptTypes(change ? original.replace(...change) : original).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

describe.skipIf(!serverUrl)('one-time recipient address privacy', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  let app: ReturnType<typeof createApp>
  let dist: string

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'one_time_mail' })
    db = createDb(owned.pool)
    f = createFixtures(db)
    dist = await mkdtemp(join(tmpdir(), 'hourmere-one-time-recipient-'))
    // Use the real shell, including all metadata; no renderer can interpolate an address.
    await writeFile(
      join(dist, 'index.html'),
      readFileSync(new URL('../../web/index.html', import.meta.url)),
    )
    const deps = {
      db,
      now: () => NOW,
      rateLimits: { page: plenty, slots: plenty, book: plenty, manage: plenty },
    }
    app = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({
        ok: false as const,
        error: 'unauthorized' as const,
        setCookie: [],
      }),
      publicUrl: PUBLIC_URL,
      webDist: dist,
      routes: [oneTimeBookingRoutes(deps), bookingRoutes(deps), publicRoutes(deps)],
    })
  })
  afterAll(async () => {
    await owned?.drop()
    if (dist) await rm(dist, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await db.deleteFrom('notification_email_sends').execute()
  })

  async function setup(team = false) {
    const marker = randomBytes(5).toString('hex')
    const host = await f.host({ handle: `hidden-host-${marker}`, timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const teamSlug = `hidden-team-${marker}`
    const organizationId = team ? await f.organization(teamSlug) : host.organizationId
    if (team) {
      await f.member(host.userId, organizationId, 'owner')
      await db
        .updateTable('auth.organization')
        .set({ name: 'Private team' })
        .where('id', '=', organizationId)
        .execute()
    }
    const slug = `private-event-${marker}`
    const eventTypeId = await f.eventType(organizationId, team ? null : host.userId, {
      slug,
      title: 'Private meeting',
      description: 'Meeting details',
      hosts: [{ userId: host.userId }],
    })
    await db
      .updateTable('event_types')
      .set({
        is_hidden: true,
        success_redirect: JSON.stringify({
          url: 'https://continue.example.test/thanks',
          parameters: ['eventTypeSlug'],
          includeInviteePersonalData: false,
          allowEmbedParent: true,
        }),
      })
      .where('id', '=', eventTypeId)
      .execute()
    const token = randomBytes(32).toString('base64url')
    await db
      .insertInto('one_time_booking_links')
      .values({
        organization_id: organizationId,
        event_type_id: eventTypeId,
        creator_user_id: host.userId,
        token_hash: createHash('sha256').update(token).digest('hex'),
      })
      .execute()
    return { host, eventTypeId, slug, teamSlug, token }
  }

  function privateAddressAbsent(value: unknown, fixture: Awaited<ReturnType<typeof setup>>) {
    const content = typeof value === 'string' ? value : JSON.stringify(value)
    for (const identifier of [fixture.host.handle, fixture.slug, fixture.teamSlug])
      expect(content.includes(identifier), 'reusable address must stay private').toBe(false)
  }

  async function checkedJson<T extends object>(
    response: Response,
    status: number,
    fixture: Awaited<ReturnType<typeof setup>>,
  ) {
    expect(response.status).toBe(status)
    const value = (await response.json()) as T
    privateAddressAbsent(value, fixture)
    return value
  }

  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  it.each([false, true])(
    'keeps hidden reusable addresses out of recipient lifecycle (team=%s)',
    async (team) => {
      const fixture = await setup(team)
      const base = `/api/v1/book/${fixture.token}`
      const html = await app.request(`/book/${fixture.token}`)
      expect(html.status).toBe(200)
      const shell = await html.text()
      privateAddressAbsent(shell, fixture)
      expect(/rel=["']canonical|property=["']og:url/.test(shell)).toBe(false)

      const key = randomUUID()
      const body = { start: '2026-11-02T09:00:00Z', invitee }
      const result = await checkedJson<Bookings.BookingWithToken>(
        await post(`${base}/bookings`, body, { 'idempotency-key': key }),
        201,
        fixture,
      )
      expect(keys(result)).toEqual(['booking', 'manageToken'])
      expect(keys(result.booking)).toEqual([...bookingKeys].sort())
      expect(keys(result.booking.attendees[0] as object)).toEqual([
        'email',
        'isBooker',
        'locale',
        'name',
        'timeZone',
      ])

      // Legacy saved continuations are never returned on an otherwise valid replay either.
      await db
        .updateTable('bookings')
        .set({
          success_redirect: JSON.stringify({
            url: `https://continue.example.test/thanks?eventTypeSlug=${fixture.slug}`,
            allowEmbedParent: true,
          }),
        })
        .where('id', '=', result.booking.id)
        .execute()
      const replay = await checkedJson<Bookings.BookingWithToken>(
        await post(`${base}/bookings`, body, { 'idempotency-key': key }),
        200,
        fixture,
      )
      expect(keys(replay)).toEqual(['booking', 'manageToken'])
      expect(replay.booking.id).toBe(result.booking.id)

      const managed = await checkedJson<Bookings.ManagedBooking>(
        await app.request('/api/v1/bookings/manage', {
          headers: { 'x-manage-token': result.manageToken as string },
        }),
        200,
        fixture,
      )
      expect(keys(managed)).toEqual([...bookingKeys, 'eventType', 'hosts'].sort())
      expect(keys(managed.eventType as object)).toEqual(['durationMinutes', 'title'])
      expect(managed.hosts.every((host: object) => keys(host).join(',') === 'name')).toBe(true)
      const manageShell = await app.request('/booking')
      privateAddressAbsent(await manageShell.text(), fixture)

      const sent: MailMessage[] = []
      const mailer: Mailer = {
        async send(message) {
          sent.push(message)
        },
      }
      const notificationDeps = {
        db,
        mailer,
        publicUrl: PUBLIC_URL,
        secret: 'synthetic-recipient-privacy-secret',
        now: () => NOW,
        log: () => {},
      }
      async function mail(
        id: string,
        kind: 'confirmed' | 'reminder' | 'rescheduled' | 'cancelled',
      ) {
        sent.length = 0
        await sendBookingNotification(notificationDeps, id, kind)
        const recipient = sent.find((message) => message.to === invitee.email)
        expect(recipient !== undefined).toBe(true)
        privateAddressAbsent(recipient, fixture)
        const attachment = recipient?.attachments?.[0]?.content
        if (kind !== 'reminder') {
          expect(attachment?.includes('BEGIN:VEVENT')).toBe(true)
          expect(attachment?.includes('\r\nURL:')).toBe(false)
        }
        const emailToken = recipient?.text.match(/#token=([A-Za-z0-9_-]+)&action=reschedule/)?.[1]
        if (kind !== 'cancelled') {
          expect(emailToken !== undefined).toBe(true)
          await checkedJson(
            await app.request('/api/v1/bookings/manage', {
              headers: { 'x-manage-token': emailToken as string },
            }),
            200,
            fixture,
          )
        }
      }
      await mail(result.booking.id, 'confirmed')
      await mail(result.booking.id, 'reminder')
      const moved = await checkedJson<Bookings.BookingWithToken>(
        await post(
          '/api/v1/bookings/manage/reschedule',
          {
            start: '2026-11-03T09:00:00Z',
          },
          { 'x-manage-token': result.manageToken as string },
        ),
        200,
        fixture,
      )
      expect(keys(moved)).toEqual(['booking', 'manageToken'])
      expect(keys(moved.booking)).toEqual([...bookingKeys].sort())
      await mail(moved.booking.id, 'rescheduled')
      const cancelled = await checkedJson<Bookings.Booking>(
        await post(
          '/api/v1/bookings/manage/cancel',
          {},
          {
            'x-manage-token': moved.manageToken as string,
          },
        ),
        200,
        fixture,
      )
      expect(keys(cancelled)).toEqual([...bookingKeys].sort())
      await mail(moved.booking.id, 'cancelled')

      // Hidden events remain reusable at their direct URL; confidentiality is the boundary.
      const direct = `/api/v1/public/${team ? `teams/${fixture.teamSlug}` : fixture.host.handle}/${fixture.slug}`
      expect((await app.request(direct)).status).toBe(200)
    },
  )

  it('kills source-copy mutations of redirect persistence and legacy replay projection', async () => {
    const normal = await bookingSourceCopy()
    const unsafeSave = await bookingSourceCopy([
      "if (!oneTimeLink && (origin.source === 'web' || origin.source === 'embed'))",
      "if (origin.source === 'web' || origin.source === 'embed')",
    ])
    const unsafeReplay = await bookingSourceCopy([
      'if (replay) return oneTimeBookingResult(replay)',
      'if (replay) return replay',
    ])
    for (const [implementation, mutation] of [
      [normal, 'none'],
      [unsafeSave, 'save'],
      [unsafeReplay, 'replay'],
    ] as const) {
      const fixture = await setup()
      const input = {
        token: fixture.token,
        start: Temporal.Instant.from('2026-11-02T11:00:00Z'),
        invitee,
        idempotencyKey: randomUUID(),
      }
      const result = await implementation.createOneTimeBooking({ db, now: () => NOW }, input)
      const row = await db
        .selectFrom('bookings')
        .select('success_redirect')
        .where('id', '=', result.booking.id)
        .executeTakeFirstOrThrow()
      const safePersistence = () =>
        expect(row.success_redirect === null, 'one-time continuation is not persisted').toBe(true)
      if (mutation === 'save') expect(safePersistence).toThrow()
      else safePersistence()
      await db
        .updateTable('bookings')
        .set({
          success_redirect: JSON.stringify({
            url: `https://continue.example.test/thanks?eventTypeSlug=${fixture.slug}`,
            allowEmbedParent: true,
          }),
        })
        .where('id', '=', result.booking.id)
        .execute()
      const replay = await implementation.createOneTimeBooking({ db, now: () => NOW }, input)
      const safeReplay = () => expect(keys(replay)).toEqual(['booking', 'manageToken', 'replayed'])
      if (mutation === 'replay') expect(safeReplay).toThrow()
      else safeReplay()
    }
  })
})
