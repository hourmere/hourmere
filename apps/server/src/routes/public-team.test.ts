import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { BookingNotifier } from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { bookingRoutes } from './bookings.ts'
import { publicRoutes } from './public.ts'
import { openApiDocument } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const range = 'start=2026-11-02T00:00:00Z&end=2026-11-03T00:00:00Z'
const input = (start = '2026-11-02T09:00:00Z') => ({
  start,
  invitee: { name: 'Guest', email: 'guest@example.com', timeZone: 'UTC' },
})
const plenty = { limit: 100_000, windowSeconds: 60 }

describe.skipIf(!serverUrl)('public single-host team booking', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const appWith = (
    notify?: BookingNotifier,
    rateLimits = { page: plenty, slots: plenty, book: plenty },
  ) =>
    createApp({
      publicUrl: 'http://localhost:3000',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [publicRoutes({ db, now, notify, rateLimits }), bookingRoutes({ db, now })],
    })
  const post = (app: ReturnType<typeof appWith>, path: string, body: unknown, key?: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key && { 'idempotency-key': key }) },
      body: JSON.stringify(body),
    })
  async function setup({
    slug = 'intro',
    teamSlug = `team-${randomUUID().slice(0, 8)}`,
    profile = true,
  } = {}) {
    const host = await f.host({
      handle: profile ? `host-${randomUUID().slice(0, 8)}` : null,
      timeZone: 'UTC',
    })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const org = await f.organization(teamSlug)
    await f.member(host.userId, org, 'owner')
    const id = await f.eventType(org, null, {
      slug,
      title: 'Team introduction',
      location: { kind: 'phone', number: '+14155550123' },
      hosts: [{ userId: host.userId }],
    })
    return { host, org, id, teamSlug, slug, path: `/api/v1/public/teams/${teamSlug}/${slug}` }
  }

  it('serves a single-host team page and redacts private details', async () => {
    const t = await setup()
    const res = await appWith().request(t.path)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body).toMatchObject({
      handle: t.teamSlug,
      slug: 'intro',
      title: 'Team introduction',
      team: { name: t.teamSlug, slug: t.teamSlug },
      host: { name: 'Ada Lovelace', timeZone: 'UTC' },
      location: { kind: 'phone' },
    })
    expect(JSON.stringify(body)).not.toContain(t.host.userId)
    expect(JSON.stringify(body)).not.toContain(t.org)
    expect(JSON.stringify(body)).not.toContain('+14155550123')
    expect(JSON.stringify(body)).not.toContain('@')
  })

  it('offers and books team slots, replays a retry and manages the booking through the existing token protocol', async () => {
    const t = await setup()
    const events: string[] = []
    const app = appWith(async (_trx, event) => {
      events.push(event.type)
    })
    const slots = (await (await app.request(`${t.path}/slots?${range}`)).json()) as {
      data: { start: string }[]
    }
    expect(slots.data.length).toBeGreaterThan(0)
    const request = input(slots.data[0]?.start)
    const key = randomUUID()
    const created = await post(app, `${t.path}/bookings`, request, key)
    expect(created.status).toBe(201)
    const body = (await created.json()) as {
      booking: { id: string; eventTypeId: string }
      manageToken: string
    }
    expect(body.booking).toMatchObject({ eventTypeId: t.id })
    expect(
      await db
        .selectFrom('bookings')
        .select('organization_id')
        .where('id', '=', body.booking.id)
        .executeTakeFirst(),
    ).toEqual({ organization_id: t.org })
    expect(body.manageToken).toBeTypeOf('string')
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', body.booking.id)
        .execute(),
    ).toEqual([{ user_id: t.host.userId }])
    const retry = await post(app, `${t.path}/bookings`, request, key)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({
      booking: { id: body.booking.id },
      manageToken: null,
    })
    expect(events).toEqual(['created'])
    const changed = await post(
      app,
      `${t.path}/bookings`,
      { ...request, invitee: { ...request.invitee, name: 'Other' } },
      key,
    )
    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({ error: 'idempotency_key_reused' })
    const headers = { 'x-manage-token': body.manageToken }
    expect((await app.request('/api/v1/bookings/manage', { headers })).status).toBe(200)
    const moved = await app.request('/api/v1/bookings/manage/reschedule', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ start: '2026-11-02T11:00:00Z' }),
    })
    expect(moved.status).toBe(200)
    const successor = (await moved.json()) as { booking: { id: string }; manageToken: string }
    const canceled = await app.request('/api/v1/bookings/manage/cancel', {
      method: 'POST',
      headers: { 'x-manage-token': successor.manageToken, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(canceled.status).toBe(200)
    expect(await canceled.json()).toMatchObject({ id: successor.booking.id, status: 'cancelled' })
  })

  it('separates personal handles, team slugs and exact-case team slugs', async () => {
    const t = await setup({ teamSlug: `Same-${randomUUID().slice(0, 8)}` })
    const lower = await setup({ teamSlug: t.teamSlug.toLowerCase() })
    await db
      .updateTable('event_types')
      .set({ title: 'Upper team' })
      .where('id', '=', t.id)
      .execute()
    await db
      .updateTable('event_types')
      .set({ title: 'Lower team' })
      .where('id', '=', lower.id)
      .execute()
    const personal = await f.host({ handle: t.teamSlug.toLowerCase(), timeZone: 'UTC' })
    await f.eventType(personal.organizationId, personal.userId, {
      slug: 'intro',
      title: 'Personal introduction',
    })
    const app = appWith()
    expect(await (await app.request(t.path)).json()).toMatchObject({ title: 'Upper team' })
    expect(await (await app.request(lower.path)).json()).toMatchObject({ title: 'Lower team' })
    expect(
      await (await app.request(`/api/v1/public/${t.teamSlug.toLowerCase()}/intro`)).json(),
    ).toMatchObject({ title: 'Personal introduction' })
  })

  it('serves an event named slots before the personal wildcard slots route', async () => {
    const t = await setup({ slug: 'slots' })
    const app = appWith()
    expect((await app.request(t.path)).status).toBe(200)
    expect((await app.request(`${t.path}/slots?${range}`)).status).toBe(200)
  })

  it('supports a host without a public profile and uses the assigned schedule for availability', async () => {
    const t = await setup({ profile: false })
    const schedule = await f.schedule(t.host.userId, {
      timeZone: 'America/New_York',
      weeklyHours: { monday: [{ start: '13:00', end: '14:00' }] },
      isDefault: false,
    })
    await db
      .updateTable('event_type_hosts')
      .set({ schedule_id: schedule })
      .where('event_type_id', '=', t.id)
      .execute()
    const app = appWith()
    expect(await (await app.request(t.path)).json()).toMatchObject({
      host: { timeZone: 'America/New_York' },
    })
    const answer = (await (await app.request(`${t.path}/slots?${range}`)).json()) as {
      data: { start: string }[]
    }
    expect(answer.data.map((slot) => slot.start)).toEqual([
      '2026-11-02T18:00:00.000Z',
      '2026-11-02T18:30:00.000Z',
    ])
  })

  it.each([
    'inactive',
    'deleted',
    'departed',
    'personal-org',
    'personal-event',
    'round-robin',
    'collective',
    'no-host',
    'two-hosts',
  ])('rejects an unsupported or inaccessible team type: %s', async (mode) => {
    const t = await setup()
    if (mode === 'inactive')
      await db.updateTable('event_types').set({ is_active: false }).where('id', '=', t.id).execute()
    if (mode === 'deleted')
      await db
        .updateTable('event_types')
        .set({ deleted_at: new Date() })
        .where('id', '=', t.id)
        .execute()
    if (mode === 'departed')
      await db
        .deleteFrom('auth.member')
        .where('organizationId', '=', t.org)
        .where('userId', '=', t.host.userId)
        .execute()
    if (mode === 'personal-org') {
      await db.deleteFrom('personal_organizations').where('user_id', '=', t.host.userId).execute()
      await db
        .insertInto('personal_organizations')
        .values({ user_id: t.host.userId, organization_id: t.org })
        .execute()
    }
    if (mode === 'personal-event')
      await db
        .updateTable('event_types')
        .set({ owner_user_id: t.host.userId })
        .where('id', '=', t.id)
        .execute()
    if (mode === 'round-robin' || mode === 'collective')
      await db
        .updateTable('event_types')
        .set({ scheduling_type: mode === 'round-robin' ? 'round_robin' : 'collective' })
        .where('id', '=', t.id)
        .execute()
    if (mode === 'no-host')
      await db.deleteFrom('event_type_hosts').where('event_type_id', '=', t.id).execute()
    if (mode === 'two-hosts') {
      const other = await f.user()
      await f.member(other, t.org)
      await db
        .insertInto('event_type_hosts')
        .values({ event_type_id: t.id, user_id: other })
        .execute()
    }
    const app = appWith()
    for (const res of [
      await app.request(t.path),
      await app.request(`${t.path}/slots?${range}`),
      await post(app, `${t.path}/bookings`, input()),
    ]) {
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: 'event_type_not_found' })
    }
    expect(
      await db.selectFrom('bookings').select('id').where('event_type_id', '=', t.id).execute(),
    ).toEqual([])
  })

  it('serializes competing team bookings and conflicts with the host’s personal bookings', async () => {
    const t = await setup()
    const app = appWith()
    const responses = await Promise.all([
      post(app, `${t.path}/bookings`, input()),
      post(app, `${t.path}/bookings`, input()),
    ])
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409])
    const personal = await f.eventType(t.host.organizationId, t.host.userId, { slug: 'personal' })
    expect(personal).toBeTypeOf('string')
    const res = await post(app, `/api/v1/public/${t.host.handle}/personal/bookings`, input())
    expect(res.status).toBe(409)
  })

  it.each(['departed', 'inactive', 'reassigned', 'two-hosts'])(
    'rechecks team eligibility after waiting for the host lock: %s',
    async (mode) => {
      const t = await setup()
      const client = await owned.pool.connect()
      let pending: Promise<Response> | undefined
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `booking-host:${t.host.userId}`,
        ])
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid
        const request = Promise.resolve(post(appWith(), `${t.path}/bookings`, input()))
        pending = request
        await vi.waitFor(async () => {
          const waiting = await owned.pool.query(
            'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))',
            [pid],
          )
          expect(waiting.rows.length).toBeGreaterThan(0)
        })
        if (mode === 'departed')
          await db
            .deleteFrom('auth.member')
            .where('organizationId', '=', t.org)
            .where('userId', '=', t.host.userId)
            .execute()
        if (mode === 'inactive')
          await db
            .updateTable('event_types')
            .set({ is_active: false })
            .where('id', '=', t.id)
            .execute()
        if (mode === 'reassigned' || mode === 'two-hosts') {
          const replacement = await f.host()
          await f.member(replacement.userId, t.org)
          if (mode === 'reassigned')
            await db.deleteFrom('event_type_hosts').where('event_type_id', '=', t.id).execute()
          await db
            .insertInto('event_type_hosts')
            .values({ event_type_id: t.id, user_id: replacement.userId })
            .execute()
        }
        await client.query('COMMIT')
        const res = await request
        expect(res.status).toBe(404)
        expect(await res.json()).toMatchObject({ error: 'event_type_not_found' })
        expect(
          await db.selectFrom('bookings').select('id').where('event_type_id', '=', t.id).execute(),
        ).toEqual([])
      } finally {
        await client.query('ROLLBACK')
        await pending
        client.release()
      }
    },
  )

  it('rate-limits team and personal page routes in the same groups', async () => {
    const t = await setup()
    const app = appWith(undefined, {
      page: { limit: 1, windowSeconds: 60 },
      slots: plenty,
      book: plenty,
    })
    expect((await app.request(t.path)).status).toBe(200)
    const res = await app.request(`/api/v1/public/${t.host.handle}`)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
  })

  it('documents the three team routes without authentication', async () => {
    const doc = await openApiDocument(appWith())
    for (const [path, method] of [
      ['/api/v1/public/teams/{handle}/{slug}', 'get'],
      ['/api/v1/public/teams/{handle}/{slug}/slots', 'get'],
      ['/api/v1/public/teams/{handle}/{slug}/bookings', 'post'],
    ]) {
      expect(doc.paths[path as string]?.[method as string]).toBeDefined()
      expect(doc.paths[path as string]?.[method as string]?.security).toBeUndefined()
    }
  })
})
