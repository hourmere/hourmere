import { createHash, randomBytes } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { bookingRoutes } from './bookings.ts'
import { oneTimeBookingRoutes } from './one-time-bookings.ts'
import { publicRoutes } from './public.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4foAAAAASUVORK5CYII=',
  'base64',
)
const hash = createHash('sha256').update(png).digest('hex')

describe.skipIf(!serverUrl)('public organization branding isolation', () => {
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
  const appWith = () =>
    createApp({
      publicUrl: 'http://localhost:3000',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [
        publicRoutes({ db, now }),
        oneTimeBookingRoutes({ db, now }),
        bookingRoutes({ db, now }),
      ],
    })
  async function brand(org: string, color: string, logo = false) {
    if (logo)
      await db
        .insertInto('organization_brand_logos')
        .values({ organization_id: org, hash, data: png })
        .execute()
    await db
      .insertInto('organization_branding')
      .values({ organization_id: org, brand_primary_color: color, brand_logo: logo ? hash : null })
      .execute()
  }
  it('uses the personal owner or team organization, including one-time and managed pages', async () => {
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const personalId = await f.eventType(host.organizationId, host.userId, { slug: 'intro' })
    const teamSlug = `team-${randomBytes(5).toString('hex')}`
    const team = await f.organization(teamSlug)
    await f.member(host.userId, team, 'owner')
    await f.eventType(team, null, { slug: 'intro', hosts: [{ userId: host.userId }] })
    await brand(host.organizationId, '#FFFFFF', true)
    await brand(team, '#000000')
    const other = await f.host()
    await brand(other.organizationId, '#AABBCC', true)
    const app = appWith()
    const get = async (path: string) => {
      const response = await app.request(path)
      expect(response.status).toBe(200)
      return response.json() as Promise<Record<string, unknown>>
    }
    const personalPath = `/api/v1/public/${host.handle}`
    const personal = await get(`${personalPath}/intro`)
    expect(personal.branding).toMatchObject({
      primaryColor: '#FFFFFF',
      logoDataUrl: `data:image/png;base64,${png.toString('base64')}`,
    })
    expect((await get(personalPath)).branding).toEqual(personal.branding)
    const teamPath = `/api/v1/public/teams/${teamSlug}/intro`
    expect((await get(teamPath)).branding).toEqual({
      name: teamSlug,
      primaryColor: '#000000',
      logoDataUrl: null,
    })
    const token = randomBytes(32).toString('base64url')
    await db
      .insertInto('one_time_booking_links')
      .values({
        organization_id: host.organizationId,
        event_type_id: personalId,
        creator_user_id: host.userId,
        token_hash: createHash('sha256').update(token).digest('hex'),
      })
      .execute()
    expect((await get(`/api/v1/book/${token}`)).eventType).toMatchObject({
      branding: personal.branding,
    })
    const created = await app.request(`${teamPath}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        start: '2026-11-02T09:00:00Z',
        invitee: { name: 'Guest', email: 'guest@example.com', timeZone: 'UTC' },
      }),
    })
    expect(created.status).toBe(201)
    const result = (await created.json()) as { manageToken: string }
    const headers = { 'x-manage-token': result.manageToken }
    const managed = await app.request('/api/v1/bookings/manage', { headers })
    expect(((await managed.json()) as { branding: unknown }).branding).toEqual({
      name: teamSlug,
      primaryColor: '#000000',
      logoDataUrl: null,
    })
    expect(
      (await app.request('/api/v1/bookings/manage/cancel', { method: 'POST', headers })).status,
    ).toBe(200)
    const cancelled = await app.request('/api/v1/bookings/manage', { headers })
    expect(await cancelled.json()).toMatchObject({
      status: 'cancelled',
      branding: { primaryColor: '#000000', logoDataUrl: null },
    })
    expect(
      (await app.request('/api/v1/bookings/manage', { headers: { 'x-manage-token': 'unknown' } }))
        .status,
    ).toBe(404)
    expect(JSON.stringify(personal)).not.toContain('#AABBCC')
  })
  it('omits branding without configuration and never serves another organization’s same-hash logo', async () => {
    const host = await f.host()
    await f.eventType(host.organizationId, host.userId, { slug: 'intro' })
    const app = appWith()
    const path = `/api/v1/public/${host.handle}/intro`
    expect(await (await app.request(path)).json()).not.toHaveProperty('branding')
    const other = await f.host()
    await brand(other.organizationId, '#123456', true)
    // Even with the same reference, a malformed own image cannot borrow another organization's image.
    await db
      .insertInto('organization_brand_logos')
      .values({ organization_id: host.organizationId, hash, data: Buffer.from('invalid PNG') })
      .execute()
    await db
      .insertInto('organization_branding')
      .values({ organization_id: host.organizationId, brand_logo: hash })
      .execute()
    expect(await (await app.request(path)).json()).not.toHaveProperty('branding')
  })
})
