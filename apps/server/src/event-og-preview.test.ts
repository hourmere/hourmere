import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from './app.ts'
import { renderOgImage } from './og-image.ts'
import { PUBLIC_RATE_LIMITS } from './rate-limit.ts'
import { oneTimeBookingRoutes } from './routes/one-time-bookings.ts'
import { publicRoutes } from './routes/public.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'https://book.example.test'
const base: Pick<AppDeps, 'authHandler' | 'resolveCaller' | 'publicUrl' | 'checkDb'> = {
  publicUrl,
  checkDb: async () => {},
  authHandler: async () => new Response(null, { status: 404 }),
  resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
}

const personal = '/api/og/event/ada'
const team = '/api/og/team/Research-Team'
const missing = `${personal}/missing`

async function image(response: Response) {
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/png')
  return {
    png: Buffer.from(await response.arrayBuffer()),
    headers: [...response.headers],
  }
}

describe.skipIf(!serverUrl)('event link previews', () => {
  let testDb: TestDatabase
  let db: Db
  let fixtures: Fixtures
  let host: Awaited<ReturnType<Fixtures['host']>>
  let app: ReturnType<typeof createApp>
  let dist: string
  let token: string

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string, undefined, { tag: 'og_preview' })
    db = createDb(testDb.pool)
    fixtures = createFixtures(db)
    host = await fixtures.host({ handle: 'ada', name: 'Ada Lovelace' })
    const teamId = await fixtures.organization('Research-Team')
    await fixtures.member(host.userId, teamId, 'owner')
    await db
      .updateTable('auth.organization')
      .set({ name: 'Research' })
      .where('id', '=', teamId)
      .execute()
    await db
      .insertInto('organization_branding')
      .values({
        organization_id: teamId,
        brand_primary_color: '#8B4B40',
      })
      .execute()

    await fixtures.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      title: 'Intro & planning',
      description: 'Description that stays outside the image',
      durationMinutes: 45,
      location: { kind: 'phone', number: '+1 202 555 0100' },
      questions: [
        {
          id: 'topic',
          label: 'Question stays outside the image',
          type: 'short_text',
          required: true,
        },
      ],
    })
    const hiddenId = await fixtures.eventType(host.organizationId, host.userId, {
      slug: 'hidden',
      title: 'Hidden personal event',
    })
    const secretId = await fixtures.eventType(host.organizationId, host.userId, {
      slug: 'secret',
      title: 'Secret personal event',
    })
    await fixtures.eventType(host.organizationId, host.userId, {
      slug: 'disabled',
      title: 'Disabled personal event',
      isActive: false,
    })
    await fixtures.eventType(host.organizationId, host.userId, {
      slug: 'deleted',
      title: 'Deleted personal event',
      deletedAt: new Date().toISOString(),
    })
    await fixtures.eventType(teamId, null, {
      slug: 'intake',
      title: 'Team intake',
      hosts: [{ userId: host.userId }],
    })
    const teamHiddenId = await fixtures.eventType(teamId, null, {
      slug: 'hidden',
      title: 'Hidden team event',
      hosts: [{ userId: host.userId }],
    })
    await fixtures.eventType(teamId, null, {
      slug: 'disabled',
      title: 'Disabled team event',
      isActive: false,
      hosts: [{ userId: host.userId }],
    })
    const roundRobin = await fixtures.eventType(teamId, null, {
      slug: 'unpublished',
      title: 'Unpublished round robin',
      hosts: [{ userId: host.userId }],
    })
    await db
      .updateTable('event_types')
      .set({ scheduling_type: 'round_robin' })
      .where('id', '=', roundRobin)
      .execute()
    await db
      .updateTable('event_types')
      .set({ is_hidden: true })
      .where('id', 'in', [hiddenId, secretId, teamHiddenId])
      .execute()

    token = randomBytes(32).toString('base64url')
    await db
      .insertInto('one_time_booking_links')
      .values({
        organization_id: host.organizationId,
        event_type_id: secretId,
        creator_user_id: host.userId,
        token_hash: createHash('sha256').update(token).digest('hex'),
        prefill_name: 'Private attendee',
        prefill_email: 'private-attendee@example.test',
      })
      .execute()

    dist = await mkdtemp(join(tmpdir(), 'hourmere-og-preview-'))
    await writeFile(
      join(dist, 'index.html'),
      await readFile(new URL('../../web/index.html', import.meta.url)),
    )
    app = createApp({
      ...base,
      webDist: dist,
      eventOgImageDb: db,
      routes: [publicRoutes({ db }), oneTimeBookingRoutes({ db })],
    })
  })

  afterAll(async () => {
    await testDb?.drop()
    if (dist) await rm(dist, { recursive: true, force: true })
  })

  it('renders only the listed personal or team booking-page inputs as a 1200 × 630 PNG', async () => {
    const personalImage = await image(await app.request(`${personal}/intro`))
    expect(await sharp(personalImage.png).metadata()).toMatchObject({
      format: 'png',
      width: 1200,
      height: 630,
    })
    expect(personalImage.png).toEqual(
      await renderOgImage({
        title: 'Intro & planning',
        durationMinutes: 45,
        name: 'Ada Lovelace',
      }),
    )
    const teamImage = await image(await app.request(`${team}/intake`))
    expect(teamImage.png).toEqual(
      await renderOgImage({
        title: 'Team intake',
        durationMinutes: 30,
        name: 'Research',
        primaryColor: '#8B4B40',
      }),
    )
  })

  it.each([
    ['hidden personal event', `${personal}/hidden`],
    ['hidden team event', `${team}/hidden`],
    ['secret one-time target', `${personal}/secret`],
    ['disabled personal event', `${personal}/disabled`],
    ['disabled team event', `${team}/disabled`],
    ['deleted event', `${personal}/deleted`],
    ['unpublished team event', `${team}/unpublished`],
    ['missing team event', `${team}/missing`],
    ['missing event with an overlapping waitlist slug', `${personal}/waitlist`],
  ])('returns the same generic bytes, cache policy and headers for a %s', async (_, path) => {
    const generic = await image(await app.request(missing))
    const actual = await image(await app.request(path))
    expect(actual.headers).toEqual(generic.headers)
    expect(actual.png.equals(generic.png)).toBe(true)
  })

  it('keeps an actual booking capability and private SPA routes outside the preview address space', async () => {
    expect((await app.request(`/api/v1/book/${token}`)).status).toBe(200)
    expect((await app.request('/api/v1/public/ada/hidden')).status).toBe(200)
    const invalid = await app.request(`/api/og/event/book/${token}`)
    const generic = await app.request(missing)
    expect(invalid.headers.get('cache-control')).toBe('no-store')
    expect(invalid.headers.get('etag')).toBe(generic.headers.get('etag'))
    expect((await image(invalid)).png).toEqual((await image(generic)).png)
    for (const path of [
      `/book/${token}`,
      `/embed/book/${token}`,
      '/poll/voter',
      '/app/bookings',
      '/route/ada/intake',
      '/route/continue#token=synthetic',
    ]) {
      const shell = await (await app.request(path)).text()
      expect(shell).not.toContain('property="og:image"')
      expect(shell).not.toContain(token)
    }
  })

  it('serves absolute preview metadata in the HTML before JavaScript runs', async () => {
    for (const [page, path] of [
      ['/ADA/Intro/', `${personal}/intro`],
      ['/team/Research-Team/intake', `${team}/intake`],
    ]) {
      const response = await app.request(`https://request.example.test${page}?private=keep-out`, {
        headers: { 'Accept-Language': 'zh-CN', 'X-Forwarded-Host': 'forged.example.test' },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-cache')
      expect(response.headers.get('vary')).toContain('Accept-Language')
      const shell = await response.text()
      expect(shell).toContain(`<meta property="og:image" content="${publicUrl}${path}" />`)
      expect(shell).toContain('<meta property="og:image:width" content="1200" />')
      expect(shell).toContain('<meta property="og:image:height" content="630" />')
      expect(shell).toContain('<meta property="og:image:alt" content="预约页面链接预览" />')
      expect(shell.match(/name="twitter:card"/g)).toHaveLength(1)
      expect(shell).toContain('<meta name="twitter:card" content="summary_large_image" />')
      expect(shell).not.toMatch(/keep-out|forged\.example|request\.example/)
    }
  })

  it('revalidates the strong ETag after title, display name, address or visibility changes', async () => {
    const id = await fixtures.eventType(host.organizationId, host.userId, { slug: 'revision' })
    const path = `${personal}/revision`
    const original = await app.request(path)
    const firstTag = original.headers.get('etag') ?? ''
    expect(firstTag).toMatch(/^"[a-f0-9]{64}"$/)
    expect(original.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    const conditional = (url: string, tag: string, method = 'GET') =>
      app.request(url, { method, headers: { 'If-None-Match': tag } })
    const unchanged = await conditional(path, `"another-tag", W/${firstTag}`)
    expect(unchanged.status).toBe(304)
    expect(unchanged.headers.get('etag')).toBe(firstTag)
    expect(unchanged.headers.get('cache-control')).toBe(original.headers.get('cache-control'))
    expect(await unchanged.text()).toBe('')
    expect((await conditional(path, firstTag, 'HEAD')).status).toBe(304)

    await db
      .updateTable('event_types')
      .set({ title: 'Revised title' })
      .where('id', '=', id)
      .execute()
    const revised = await conditional(path, firstTag)
    const secondTag = revised.headers.get('etag') ?? ''
    expect(revised.status).toBe(200)
    expect(secondTag).not.toBe(firstTag)

    await db
      .updateTable('auth.user')
      .set({ name: 'Ada Byron' })
      .where('id', '=', host.userId)
      .execute()
    const renamed = await conditional(path, secondTag)
    const thirdTag = renamed.headers.get('etag') ?? ''
    expect(renamed.status).toBe(200)
    expect(thirdTag).not.toBe(secondTag)

    await db
      .updateTable('event_types')
      .set({ slug: 'revised-address' })
      .where('id', '=', id)
      .execute()
    const generic = await image(await app.request(missing))
    expect(await image(await conditional(path, thirdTag))).toEqual(generic)
    expect((await conditional(`${personal}/revised-address`, thirdTag)).status).toBe(304)

    await db.updateTable('event_types').set({ is_hidden: true }).where('id', '=', id).execute()
    expect(await image(await conditional(`${personal}/revised-address`, thirdTag))).toEqual(generic)
  })

  it('limits requests across both image paths and refuses a forged forwarding header', async () => {
    const limited = createApp({ ...base, eventOgImageDb: db })
    const { limit, windowSeconds } = PUBLIC_RATE_LIMITS.ogImage
    for (let i = 0; i < limit; i++) {
      const path = i % 2 === 0 ? missing : `${team}/missing`
      expect((await limited.request(path)).status).toBe(200)
    }
    const refused = await limited.request(`${team}/missing`, {
      headers: { 'X-Forwarded-For': '192.0.2.1' },
    })
    expect(refused.status).toBe(429)
    expect(refused.headers.get('cache-control')).toBe('no-store')
    const retryAfter = Number(refused.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(windowSeconds)
    expect(await refused.json()).toEqual({ error: 'rate_limited' })
  })
})
