import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { activateRoundRobin, createEventType } from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type Fixtures,
  testContext,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { type PublicRoutesDeps, publicRoutes } from './routes/public.ts'

const bootstrap = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const START = '2026-11-02T09:00:00.000Z'
const END = '2026-11-02T09:30:00.000Z'
const plenty = { limit: 100_000, windowSeconds: 60 }
const query = new URLSearchParams({ start: START, durationMinutes: '30' }).toString()
type App = ReturnType<typeof createApp>

describe.skipIf(!bootstrap)('ordinary direct-slot public reads and final booking', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  let dist: string
  let notifications = 0

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'slot_link' })
    db = createDb(owned.pool)
    f = createFixtures(db)
    dist = await mkdtemp(join(tmpdir(), 'hourmere-slot-link-'))
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>Hourmere</title>')
  })
  afterAll(async () => {
    await owned?.drop()
    if (dist) await rm(dist, { recursive: true, force: true })
  })

  function application(routes = publicRoutes): App {
    return createApp({
      publicUrl: 'https://booking.example.test',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      webDist: dist,
      embedOrigins: ['https://parent.example.test'],
      routes: [
        routes({
          db,
          now: () => NOW,
          rateLimits: { page: plenty, slots: plenty, book: plenty },
          notify: async () => {
            notifications++
          },
        }),
      ],
    })
  }

  async function personal(hidden = false) {
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const eventId = await f.eventType(host.organizationId, host.userId, { slug: 'intro' })
    if (hidden)
      await db
        .updateTable('event_types')
        .set({ is_hidden: true })
        .where('id', '=', eventId)
        .execute()
    return {
      host,
      eventId,
      html: `/${host.handle}/intro`,
      api: `/api/v1/public/${host.handle}/intro`,
    }
  }

  async function team(mode: 'individual' | 'collective' | 'round_robin') {
    const owner = await createTestUser(db, 'Original host')
    const alternate = await createTestUser(db, 'Alternate host')
    const hosts = mode === 'individual' ? [owner] : [owner, alternate]
    const organization = await createTestTeam(
      db,
      hosts.map((user, index) => ({ user, role: index === 0 ? 'owner' : 'member' })),
    )
    for (const host of hosts) await f.schedule(host.id, { timeZone: 'UTC' })
    const context = testContext(db, organization.as(owner), () => NOW)
    const event = await createEventType(context, {
      slug: 'intro',
      title: 'Current team meeting',
      durationMinutes: 30,
      allowedDurationsMinutes: [30, 60],
      schedulingType: mode,
      hosts: hosts.map((host) => ({ userId: host.id })),
    })
    if (mode === 'round_robin') await activateRoundRobin(context, event.id)
    const slug = context.principal.organization.slug
    return {
      owner,
      alternate,
      organization,
      eventId: event.id,
      html: `/team/${slug}/intro`,
      api: `/api/v1/public/teams/${slug}/intro`,
    }
  }

  async function exact(app: App, api: string, start = START, durationMinutes = 30) {
    return app.request(
      `${api}/slots?${new URLSearchParams({
        start,
        end: Temporal.Instant.from(start).add({ minutes: durationMinutes }).toString(),
        durationMinutes: String(durationMinutes),
      })}`,
    )
  }

  async function snapshot() {
    const counts = await owned.pool.query(`SELECT
      (SELECT count(*)::int FROM bookings) AS bookings,
      (SELECT count(*)::int FROM booking_hosts) AS hosts,
      (SELECT count(*)::int FROM booking_attendees) AS attendees,
      (SELECT count(*)::int FROM booking_notifications) AS mail,
      (SELECT count(*)::int FROM booking_conferences) AS conferences,
      (SELECT count(*)::int FROM webhook_deliveries) AS webhooks,
      (SELECT count(*)::int FROM one_time_booking_links) AS capabilities,
      (SELECT count(*)::int FROM waitlist_entries) AS waitlist`)
    const fairness = await db
      .selectFrom('round_robin_state')
      .select(['event_type_id', 'next_sequence'])
      .orderBy('event_type_id')
      .execute()
    const hosts = await db
      .selectFrom('event_type_hosts')
      .select(['event_type_id', 'user_id', 'last_assigned_sequence'])
      .orderBy('event_type_id')
      .orderBy('user_id')
      .execute()
    return { ...counts.rows[0], fairness, hosts, notifications }
  }

  async function assertReadOnly(app: App, s: { html: string; api: string }) {
    const before = await snapshot()
    for (let scanner = 0; scanner < 3; scanner++) {
      const html = await app.request(`${s.html}?${query}`, {
        headers: { 'user-agent': 'Synthetic email scanner' },
      })
      expect(html.status).toBe(200)
      expect(await html.text()).toContain('<title>Hourmere</title>')
      expect(html.headers.get('cache-control')).toBe('no-cache')
      expect(html.headers.get('x-frame-options')).toBe('DENY')
      expect(html.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
      expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(html.headers.get('x-content-type-options')).toBe('nosniff')
      expect(html.headers.get('strict-transport-security')).toBe('max-age=31536000')
      for (const response of [await app.request(`${s.api}?${query}`), await exact(app, s.api)]) {
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('x-frame-options')).toBe('DENY')
        expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
        expect(response.headers.get('set-cookie')).toBeNull()
        const body = await response.text()
        for (const field of ['manageToken', 'hostId', 'nextSequence', 'availableHostCount'])
          expect(body).not.toContain(field)
      }
    }
    expect(await snapshot()).toEqual(before)
  }

  it.each(['personal', 'individual', 'collective', 'round_robin'] as const)(
    'repeated %s scanner HTML, metadata and exact-slot GETs have no business effects',
    async (mode) => {
      const s = mode === 'personal' ? await personal() : await team(mode)
      await assertReadOnly(application(), s)
    },
  )

  it('detects a source-copy mutation that advances fairness during exact-slot preview', async () => {
    const s = await team('round_robin')
    const location = new URL('./routes/public.ts', import.meta.url)
    const original = readFileSync(location, 'utf8')
    const target = "const { start, end, durationMinutes, locationOptionId } = c.req.valid('query')"
    expect(original).toContain(target)
    const source = stripTypeScriptTypes(
      original.replace(
        target,
        `${target}\n await db.updateTable('round_robin_state').set({ next_sequence: '99' }).execute()`,
      ),
    ).replace(/from '([^']+)'/g, (_, specifier: string) => {
      const resolved = specifier.startsWith('.')
        ? new URL(specifier, location).href
        : import.meta.resolve(specifier)
      return `from '${resolved}'`
    })
    const copy: { publicRoutes: (deps: PublicRoutesDeps) => ReturnType<typeof publicRoutes> } =
      await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
    await expect(assertReadOnly(application(copy.publicRoutes), s)).rejects.toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it.each([false, true])(
    'hidden reusable direct addresses remain available (team=%s)',
    async (isTeam) => {
      const s = isTeam ? await team('individual') : await personal(true)
      await db
        .updateTable('event_types')
        .set({ is_hidden: true })
        .where('id', '=', s.eventId)
        .execute()
      const app = application()
      expect((await app.request(`${s.api}?${query}`)).status).toBe(200)
      expect(await (await exact(app, s.api)).json()).toEqual({ data: [{ start: START, end: END }] })
      if (!isTeam && 'host' in s) {
        const listing = await app.request(`/api/v1/public/${s.host.handle}`)
        expect(await listing.json()).toMatchObject({ eventTypes: [] })
      }
    },
  )

  it('rechecks round-robin availability without pinning the host and assigns only on submit', async () => {
    const s = await team('round_robin')
    const app = application()
    const originalBusy = await f.calendarBusy(s.alternate.id, [[START, END]])
    expect(await (await exact(app, s.api)).json()).toEqual({ data: [{ start: START, end: END }] })
    await db
      .deleteFrom('calendar_busy')
      .where('calendar_id', '=', originalBusy.calendarId)
      .execute()
    await f.calendarBusy(s.owner.id, [[START, END]])
    const before = await snapshot()
    const current = await exact(app, s.api)
    expect(await current.json()).toEqual({ data: [{ start: START, end: END }] })
    expect(await snapshot()).toEqual(before)
    const response = await app.request(`${s.api}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        start: START,
        durationMinutes: 30,
        invitee: { name: 'Invitee', email: 'invitee@example.test', timeZone: 'UTC' },
      }),
    })
    expect(response.status).toBe(201)
    const result = (await response.json()) as { booking: { id: string; source: string } }
    expect(result.booking.source).toBe('web')
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', result.booking.id)
        .execute(),
    ).toEqual([{ user_id: s.alternate.id }])
    expect(
      await db
        .selectFrom('round_robin_state')
        .select('next_sequence')
        .where('event_type_id', '=', s.eventId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ next_sequence: '1' })
  })

  it('requires every collective host for the complete interval, including end-only conflicts', async () => {
    const s = await team('collective')
    const app = application()
    expect(await (await exact(app, s.api, START, 60)).json()).toEqual({
      data: [{ start: START, end: '2026-11-02T10:00:00.000Z' }],
    })
    await f.calendarBusy(s.alternate.id, [['2026-11-02T09:45:00Z', '2026-11-02T10:00:00Z']])
    const response = await exact(app, s.api, START, 60)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [] })
    expect(await (await exact(app, s.api)).json()).toEqual({ data: [{ start: START, end: END }] })
  })

  it('filters a taken interval freshly without exposing the other booking', async () => {
    const s = await personal()
    const app = application()
    expect(await (await exact(app, s.api)).json()).toEqual({ data: [{ start: START, end: END }] })
    await f.booking(s.host.organizationId, [s.host.userId], START, END, {
      attendee: { name: 'Private attendee', email: 'private-attendee@example.test' },
    })
    const before = await snapshot()
    const stale = await exact(app, s.api)
    expect(stale.status).toBe(200)
    expect(await stale.json()).toEqual({ data: [] })
    expect(await snapshot()).toEqual(before)
  })

  it('ignores host, end, source, language and redirect extras on ordinary metadata without logging the query', async () => {
    const s = await personal()
    const lines: string[] = []
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((...args) => void lines.push(args.join(' ')))
    try {
      const app = application()
      const extra =
        '&hostId=private-host&end=private-end&source=mcp&locale=de&redirect=https%3A%2F%2Fevil.example'
      const response = await app.request(`${s.api}?${query}${extra}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ handle: s.host.handle, slug: 'intro' })
      expect(lines.some((line) => line.includes(s.api))).toBe(true)
      expect(lines.join('\n')).not.toMatch(
        /durationMinutes|private-host|private-end|evil\.example|2026-11-02/,
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('retains embed framing and capability privacy policies with appended slot hints', async () => {
    const s = await personal()
    const app = application()
    const ordinary = await app.request(
      `${s.html}?${query}&parentOrigin=https%3A%2F%2Fparent.example.test`,
    )
    expect(ordinary.headers.get('x-frame-options')).toBe('DENY')
    const embed = await app.request(
      `/embed${s.html}?${query}&parentOrigin=https%3A%2F%2Fparent.example.test&embedId=syntheticSlotLink01`,
    )
    expect(embed.status).toBe(200)
    expect(embed.headers.get('x-frame-options')).toBeNull()
    expect(embed.headers.get('content-security-policy')).toContain(
      'frame-ancestors https://parent.example.test',
    )
    expect(embed.headers.get('referrer-policy')).toBe('no-referrer')
    for (const path of [
      `/book/${'a'.repeat(43)}`,
      `${s.html}/waitlist/${'b'.repeat(43)}/${encodeURIComponent(START)}/9999999999999`,
    ]) {
      const response = await app.request(`${path}?${query}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('x-frame-options')).toBe('DENY')
    }
  })
})
