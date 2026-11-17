import { createHash, randomBytes } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { bookingRoutes } from './bookings.ts'
import { oneTimeBookingRoutes } from './one-time-bookings.ts'
import { publicRoutes } from './public.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: 'white' } })
  .png()
  .toBuffer()
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
      logoDataUrl: null,
      logoUrl: expect.stringMatching(
        new RegExp(`^/api/v1/public/branding/${host.organizationId}/logo/[a-f0-9]{64}$`),
      ),
    })
    expect((await get(personalPath)).branding).toEqual(personal.branding)
    const teamPath = `/api/v1/public/teams/${teamSlug}/intro`
    expect((await get(teamPath)).branding).toEqual({
      name: teamSlug,
      primaryColor: '#000000',
      logoDataUrl: null,
      logoUrl: null,
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
      logoUrl: null,
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
  it('serves bounded legacy images with immutable caching and uniform cross-organization misses', async () => {
    const owner = await f.host()
    const other = await f.host()
    const legacy = await sharp({
      create: { width: 1800, height: 900, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer()
    const legacyHash = createHash('sha256').update(legacy).digest('hex')
    await db
      .insertInto('organization_brand_logos')
      .values({ organization_id: owner.organizationId, hash: legacyHash, data: legacy })
      .execute()
    await db
      .insertInto('organization_branding')
      .values({ organization_id: owner.organizationId, brand_logo: legacyHash })
      .execute()
    await f.eventType(owner.organizationId, owner.userId, { slug: 'logo' })
    const app = appWith()
    const page = (await (await app.request(`/api/v1/public/${owner.handle}/logo`)).json()) as {
      branding: { logoUrl: string; logoDataUrl: null }
    }
    expect(page.branding.logoDataUrl).toBeNull()
    expect(JSON.stringify(page)).not.toContain('data:image')
    const response = await app.request(page.branding.logoUrl)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes.length).toBeLessThanOrEqual(64 * 1024)
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 512, height: 256 })
    const hash = createHash('sha256').update(bytes).digest('hex')
    expect(page.branding.logoUrl).toContain(`/logo/${hash}`)
    const missing = await app.request(
      `/api/v1/public/branding/${other.organizationId}/logo/${'f'.repeat(64)}`,
    )
    const foreign = await app.request(
      `/api/v1/public/branding/${other.organizationId}/logo/${hash}`,
    )
    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
    expect(foreign.headers.get('cache-control')).toBe('no-store')
    const malformed = await app.request(`/api/v1/public/branding/not-a-uuid/logo/${hash}`)
    expect(malformed.status).toBe(400)
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
