import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  ensureWaitlistKey,
  joinWaitlist,
  mintWaitlistManagementToken,
  openWaitlistVerificationOutbox,
  verifyWaitlist,
  type WaitlistContext,
} from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { publicRoutes } from './routes/public.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const secret = 'synthetic-http-waitlist-attribution-secret'

describe.skipIf(!serverUrl)('waitlist attribution through the ordinary HTTP booking path', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: WaitlistContext
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'waitlist_http' })
    db = createDb(owned.pool)
    f = createFixtures(db)
    ctx = { db, secret, publicUrl: 'https://schedule.example', now: () => NOW }
    await db.transaction().execute((trx) => ensureWaitlistKey(trx, secret))
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(register = publicRoutes) {
    const host = await f.host()
    const eventId = await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      minimumNoticeMinutes: 0,
    })
    const scheduleId = await f.schedule(host.userId, { weeklyHours: {} })
    await db
      .updateTable('event_types')
      .set({ waitlist_enabled: true })
      .where('id', '=', eventId)
      .execute()
    const email = `${randomUUID()}@example.test`
    await joinWaitlist(ctx, {
      handle: host.handle,
      slug: 'intro',
      email,
      consent: true,
      preferredWindow: {
        start: '2026-11-02T08:00:00Z',
        end: '2026-11-02T10:00:00Z',
        timeZone: 'Europe/Berlin',
      },
    })
    const entry = await db
      .selectFrom('waitlist_entries')
      .select('id')
      .where('event_type_id', '=', eventId)
      .executeTakeFirstOrThrow()
    const outbox = await db
      .selectFrom('waitlist_verification_outbox')
      .selectAll()
      .where('entry_id', '=', entry.id)
      .executeTakeFirstOrThrow()
    const opened = openWaitlistVerificationOutbox(ctx, outbox)
    await verifyWaitlist(ctx, { token: opened?.verificationToken as string })
    const token = await db
      .transaction()
      .execute((trx) => mintWaitlistManagementToken(trx, entry.id, new Date(NOW.epochMilliseconds)))
    await db
      .updateTable('schedules')
      .set({ weekly_hours: JSON.stringify({ monday: [{ start: '09:00', end: '11:00' }] }) })
      .where('id', '=', scheduleId)
      .execute()
    const app = createApp({
      checkDb: async () => {},
      publicUrl: ctx.publicUrl,
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [register({ db, now: () => NOW, waitlistSecret: secret })],
    })
    const post = (waitlistToken?: string, key = randomUUID()) =>
      app.request(`/api/v1/public/${host.handle}/intro/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({
          start: '2026-11-02T08:00:00Z',
          invitee: { name: 'Synthetic Invitee', email, timeZone: 'Europe/Berlin' },
          ...(waitlistToken === undefined ? {} : { waitlistToken }),
        }),
      })
    const status = async () =>
      (
        await db
          .selectFrom('waitlist_entries')
          .select('status')
          .where('id', '=', entry.id)
          .executeTakeFirstOrThrow()
      ).status
    return { token, post, status }
  }

  it('marks a matching verified entry booked only on a new successful booking', async () => {
    const s = await setup()
    expect((await s.post(s.token)).status).toBe(201)
    expect(await s.status()).toBe('booked')
  })
  it('ignores malformed optional tokens and never links tokenless idempotent replays', async () => {
    const s = await setup()
    const key = randomUUID()
    expect((await s.post('not-a-capability', key)).status).toBe(201)
    expect(await s.status()).toBe('active')
    expect((await s.post(s.token, key)).status).toBe(200)
    expect(await s.status()).toBe('active')
  })
  async function sourceCopy(before?: string, after = ''): Promise<typeof publicRoutes> {
    const url = new URL('./routes/public.ts', import.meta.url)
    let source = readFileSync(url, 'utf8')
    if (before) {
      expect(source.includes(before), 'mutation must match source').toBe(true)
      source = source.replace(before, after)
    }
    source = stripTypeScriptTypes(source)
    const bindings: Record<string, unknown> = {}
    for (const match of [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]) {
      const specifier = match[2] as string
      const imported = await import(
        specifier.startsWith('.') ? new URL(specifier, url).href : specifier
      )
      for (const binding of (match[1] as string)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)) {
        const [name, local] = binding.split(/\s+as\s+/)
        bindings[local ?? (name as string)] = imported[name as string]
      }
      source = source.replace(match[0], '')
    }
    source = source.replace(/^export \{[^}]*\}\n/gm, '').replace(/\bexport /g, '')
    return new Function(...Object.keys(bindings), `${source}; return publicRoutes`)(
      ...Object.values(bindings),
    )
  }
  async function assertAttribution(register: typeof publicRoutes) {
    const s = await setup(register)
    expect((await s.post(s.token)).status).toBe(201)
    expect(await s.status()).toBe('booked')
  }
  it('detects dropping waitlist attribution before the ordinary transaction in an isolated route copy', async () => {
    await assertAttribution(await sourceCopy())
    const copied = await sourceCopy('waitlistToken: body.waitlistToken,', '')
    await expect(assertAttribution(copied)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
