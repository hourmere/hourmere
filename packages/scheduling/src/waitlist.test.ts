import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFixtures, type Fixtures } from './testing.ts'
import {
  cleanupWaitlist,
  ensureWaitlistKey,
  getWaitlistEntry,
  joinWaitlist,
  mintWaitlistManagementToken,
  openWaitlistVerificationOutbox,
  prepareWaitlistVerification,
  removeWaitlist,
  resendWaitlistVerification,
  verifyWaitlist,
  type WaitlistContext,
  waitlistIpBucket,
  waitlistRecipientHash,
  waitlistTokenHash,
} from './waitlist.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

describe.skipIf(!serverUrl)('internal waitlist admission and lifecycle', () => {
  let testDb: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: WaitlistContext
  let clock = NOW

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    f = createFixtures(db)
    ctx = {
      db,
      secret: 'synthetic-waitlist-test-secret',
      publicUrl: 'https://schedule.example',
      trustedIp: '192.0.2.1',
      now: () => clock,
    }
  })
  afterAll(async () => {
    await testDb?.drop()
  })
  beforeEach(async () => {
    clock = NOW
    await db.deleteFrom('waitlist_entries').execute()
    await db.deleteFrom('waitlist_verification_requests').execute()
    await db.deleteFrom('waitlist_key_state').execute()
  })

  async function event() {
    const host = await f.host()
    const eventId = await f.eventType(host.organizationId, host.userId, { slug: 'intro' })
    await db
      .updateTable('event_types')
      .set({ waitlist_enabled: true })
      .where('id', '=', eventId)
      .execute()
    return { host, eventId, handle: host.handle, slug: 'intro' }
  }
  function input(et: Awaited<ReturnType<typeof event>>, email = 'invitee@example.test') {
    return {
      handle: et.handle,
      slug: et.slug,
      email,
      name: 'Invitee',
      consent: true as const,
      preferredWindow: {
        start: clock.add({ hours: 12 }).toString(),
        end: '2026-11-30T00:00:00Z',
        timeZone: 'America/Los_Angeles',
      },
      locale: 'de',
    }
  }
  async function outbox() {
    return db
      .selectFrom('waitlist_verification_outbox')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('generation', 'desc')
      .executeTakeFirstOrThrow()
  }
  async function entry() {
    return db.selectFrom('waitlist_entries').selectAll().executeTakeFirstOrThrow()
  }
  async function verification() {
    const row = await outbox()
    const payload = openWaitlistVerificationOutbox(ctx, row)
    if (!payload) throw new Error('Expected authenticated verification payload')
    return payload.verificationToken
  }
  async function management() {
    const row = await entry()
    return db
      .transaction()
      .execute((trx) => mintWaitlistManagementToken(trx, row.id, new Date(clock.epochMilliseconds)))
  }
  async function countRequests() {
    return Number(
      (
        await db
          .selectFrom('waitlist_verification_requests')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    )
  }
  async function seedRequests(
    count: number,
    patch: {
      requested_at?: Date
      event_type_id?: string
      email_hash?: Buffer
      ip_hash?: Buffer
    } = {},
  ) {
    const first = await db
      .selectFrom('waitlist_verification_requests')
      .selectAll()
      .executeTakeFirstOrThrow()
    if (count)
      await db
        .insertInto('waitlist_verification_requests')
        .values(
          Array.from({ length: count }, () => ({
            event_type_id: first.event_type_id,
            email_hash: first.email_hash,
            ip_hash: first.ip_hash,
            generation_id: randomUUID(),
            requested_at: new Date(clock.epochMilliseconds),
            ...patch,
          })),
        )
        .execute()
  }

  it('stores only hashed capabilities and authenticated encrypted outbox; generic response has no contact or token', async () => {
    const et = await event()
    expect(await joinWaitlist(ctx, input(et, '  PERSON+tag@Example.test  '))).toEqual({
      accepted: true,
    })
    const row = await entry(),
      mail = await outbox(),
      token = await verification()
    expect(row.email).toBe('person+tag@example.test')
    expect(row.status).toBe('pending_verification')
    expect(row.expires_at.toISOString()).toBe('2026-11-30T00:00:00.000Z')
    expect(row.pending_expires_at.getTime() - row.created_at.getTime()).toBe(DAY)
    expect(mail.encrypted_payload?.toString().includes(token)).toBe(false)
    expect(mail.encrypted_payload?.toString()).not.toContain('person+tag')
    const cap = await db.selectFrom('waitlist_capabilities').selectAll().executeTakeFirstOrThrow()
    expect(cap.token_hash.equals(waitlistTokenHash(token, 'verification'))).toBe(true)
    expect(
      waitlistTokenHash(token, 'verification').equals(waitlistTokenHash(token, 'management')),
    ).toBe(false)
    expect(cap.expires_at.getTime() - row.created_at.getTime()).toBe(30 * 60_000)
    expect(
      openWaitlistVerificationOutbox({ ...ctx, publicUrl: 'https://other.example' }, mail),
    ).toBeUndefined()
    expect(openWaitlistVerificationOutbox(ctx, { ...mail, id: randomUUID() })).toBeUndefined()
    expect(openWaitlistVerificationOutbox(ctx, { ...mail, generation: 2 })).toBeUndefined()
    expect(openWaitlistVerificationOutbox({ ...ctx, secret: 'rotated' }, mail)).toBeUndefined()
  })

  it('rechecks availability and never admits verification when a slot now exists', async () => {
    const et = await event()
    await f.schedule(et.host.userId)
    await expect(joinWaitlist(ctx, input(et))).rejects.toMatchObject({
      code: 'availability_changed',
    })
    expect(await countRequests()).toBe(0)
    expect(await db.selectFrom('waitlist_verification_outbox').select('id').execute()).toEqual([])
  })

  it('propagates stale calendar errors instead of treating them as empty', async () => {
    const et = await event()
    await f.schedule(et.host.userId)
    await f.calendarBusy(et.host.userId, [['2026-11-02T08:00Z', '2026-11-02T18:00Z']])
    await db
      .updateTable('calendar_connections')
      .set({ provider: 'google' })
      .where('user_id', '=', et.host.userId)
      .execute()
    await expect(joinWaitlist(ctx, input(et))).rejects.toMatchObject({
      code: 'calendar_sync_unavailable',
    })
    expect(await countRequests()).toBe(0)
  })

  it('validates consent, bounded text, offsets, time zones and future elapsed windows before admission', async () => {
    const et = await event(),
      base = input(et)
    for (const bad of [
      { ...base, consent: false },
      { ...base, email: 'bad' },
      { ...base, name: 'one\r\nBcc: other@example.test' },
      { ...base, preferredWindow: { ...base.preferredWindow, start: '2026-11-02T01:30' } },
      { ...base, preferredWindow: { ...base.preferredWindow, timeZone: '+01:00' } },
      { ...base, preferredWindow: { ...base.preferredWindow, timeZone: 'Invalid/Zone' } },
      { ...base, preferredWindow: { ...base.preferredWindow, start: '2026-10-31T00:00:00Z' } },
      { ...base, preferredWindow: { ...base.preferredWindow, end: '2027-01-03T00:00:00Z' } },
    ])
      await expect(joinWaitlist(ctx, bad as typeof base)).rejects.toBeInstanceOf(Error)
    expect(await countRequests()).toBe(0)
  })

  it.each(['start', 'end'] as const)(
    'rejects huge malformed %s before parsing instants or admitting mail',
    async (field) => {
      const et = await event(),
        base = input(et)
      const parseInstant = vi.spyOn(Temporal.Instant, 'from')
      try {
        for (const value of ['T'.repeat(100_000), `2026-11-02T00:00:00.${'1'.repeat(100_000)}Z`]) {
          await expect(
            joinWaitlist(ctx, {
              ...base,
              preferredWindow: { ...base.preferredWindow, [field]: value },
            }),
          ).rejects.toMatchObject({ code: 'invalid_waitlist_input' })
        }
        expect(parseInstant.mock.calls.length).toBe(0)
        expect(await countRequests()).toBe(0)
        expect(await db.selectFrom('waitlist_entries').select('id').execute()).toHaveLength(0)
        expect(
          await db.selectFrom('waitlist_verification_outbox').select('id').execute(),
        ).toHaveLength(0)
      } finally {
        parseInstant.mockRestore()
      }
    },
  )

  it.each(['start', 'end'] as const)(
    'requires the complete RFC3339 shape for %s despite permissive Temporal parsing',
    async (field) => {
      const et = await event(),
        base = input(et)
      const date = field === 'start' ? '2026-11-02' : '2026-11-30'
      // Temporal also accepts these ISO8601 forms; the service contract requires RFC3339.
      for (const value of [
        `${date.replaceAll('-', '')}T000000Z`,
        `${date}T00:00Z`,
        `${date}T00:00:00+0000`,
        `${date}T00:00:00Z[UTC]`,
      ]) {
        expect(() => Temporal.Instant.from(value)).not.toThrow()
        await expect(
          joinWaitlist(ctx, {
            ...base,
            preferredWindow: { ...base.preferredWindow, [field]: value },
          }),
        ).rejects.toMatchObject({ code: 'invalid_waitlist_input' })
      }
      expect(await countRequests()).toBe(0)
      expect(await db.selectFrom('waitlist_entries').select('id').execute()).toHaveLength(0)
    },
  )

  it('accepts RFC3339 offsets and bounded fractions and stores UTC milliseconds', async () => {
    const et = await event(),
      base = input(et)
    await expect(
      joinWaitlist(ctx, {
        ...base,
        preferredWindow: {
          ...base.preferredWindow,
          start: '2026-11-02T01:00:00.123456789+01:00',
          end: '2026-11-30T01:00:00.1+01:00',
        },
      }),
    ).resolves.toEqual({ accepted: true })
    const row = await entry()
    expect(row.window_start?.toISOString()).toBe('2026-11-02T00:00:00.123Z')
    expect(row.window_end?.toISOString()).toBe('2026-11-30T00:00:00.100Z')
    expect(row.expires_at.toISOString()).toBe('2026-11-30T00:00:00.100Z')
    expect(await countRequests()).toBe(1)
  })

  it('requires enabled supported single-host events; supported teams use the same lifecycle', async () => {
    const et = await event()
    await db
      .updateTable('event_types')
      .set({ waitlist_enabled: false })
      .where('id', '=', et.eventId)
      .execute()
    await expect(joinWaitlist(ctx, input(et))).rejects.toMatchObject({
      code: 'waitlist_unavailable',
    })
    const org = await f.organization()
    await f.member(et.host.userId, org)
    const teamId = await f.eventType(org, null, {
      slug: 'intro',
      hosts: [{ userId: et.host.userId }],
    })
    await db
      .updateTable('event_types')
      .set({ waitlist_enabled: true })
      .where('id', '=', teamId)
      .execute()
    const organization = await db
      .selectFrom('auth.organization')
      .select('slug')
      .where('id', '=', org)
      .executeTakeFirstOrThrow()
    await expect(
      joinWaitlist(ctx, { ...input(et), handle: organization.slug, team: true }),
    ).resolves.toEqual({ accepted: true })
    const second = await f.host()
    await f.member(second.userId, org)
    const collective = await f.eventType(org, null, {
      slug: 'collective',
      hosts: [{ userId: et.host.userId }, { userId: second.userId }],
    })
    await db
      .updateTable('event_types')
      .set({ scheduling_type: 'collective' })
      .where('id', '=', collective)
      .execute()
    await expect(
      joinWaitlist(ctx, {
        ...input(et),
        handle: organization.slug,
        slug: 'collective',
        team: true,
      }),
    ).rejects.toMatchObject({ code: 'waitlist_unsupported' })
  })

  it('duplicate join neither replaces preferences nor renews deadlines or sends again', async () => {
    const et = await event(),
      base = input(et)
    await joinWaitlist(ctx, base)
    const before = await entry()
    clock = clock.add({ minutes: 16 })
    await joinWaitlist(ctx, {
      ...base,
      name: 'Replacement',
      locale: 'fr',
      preferredWindow: { ...base.preferredWindow, end: '2026-12-01T00:00:00Z' },
    })
    expect(await entry()).toEqual(before)
    expect(await countRequests()).toBe(1)
    expect(await db.selectFrom('waitlist_verification_outbox').select('id').execute()).toHaveLength(
      1,
    )
  })

  it('explicit verification activates once, permits safe replay, and never sends a success email', async () => {
    const et = await event()
    await joinWaitlist(ctx, input(et))
    const token = await verification(),
      managementToken = await management(),
      before = await entry()
    await expect(verifyWaitlist(ctx, { token: managementToken })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
    expect((await entry()).status).toBe('pending_verification')
    await expect(verifyWaitlist(ctx, { token })).resolves.toEqual({ verified: true })
    clock = clock.add({ minutes: 1 })
    await expect(verifyWaitlist(ctx, { token })).resolves.toEqual({ verified: true })
    expect((await entry()).status).toBe('active')
    expect((await entry()).expires_at).toEqual(before.expires_at)
    expect(await countRequests()).toBe(1)
    expect((await outbox()).encrypted_payload).toBeNull()
  })

  it('verification expiry is strict at equality, including pending expiry; old tokens cannot reactivate', async () => {
    const et = await event()
    await joinWaitlist(ctx, input(et))
    const token = await verification()
    clock = clock.add({ minutes: 30 })
    await expect(verifyWaitlist(ctx, { token })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
    clock = NOW.add({ hours: 24 })
    await cleanupWaitlist(ctx)
    expect((await entry()).status).toBe('expired')
    expect((await entry()).email).toBeNull()
    await expect(verifyWaitlist(ctx, { token })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
  })

  it('resend enforces 15-minute equality, supersedes verification generation, and preserves saved input', async () => {
    const et = await event(),
      base = input(et)
    await joinWaitlist(ctx, base)
    const first = await verification(),
      before = await entry()
    clock = NOW.add({ minutes: 14, seconds: 59 })
    await resendWaitlistVerification(ctx, base)
    expect(await countRequests()).toBe(1)
    clock = NOW.add({ minutes: 15 })
    await resendWaitlistVerification(ctx, base)
    const second = await verification()
    expect(second === first).toBe(false)
    expect(await countRequests()).toBe(2)
    expect((await entry()).verification_generation).toBe(2)
    expect((await entry()).expires_at).toEqual(before.expires_at)
    await expect(verifyWaitlist(ctx, { token: first })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
    await expect(verifyWaitlist(ctx, { token: second })).resolves.toEqual({ verified: true })
    await resendWaitlistVerification(ctx, base)
    expect(await countRequests()).toBe(2)
  })

  it('generation fencing rejects an old token even if its revocation was lost', async () => {
    const et = await event()
    await joinWaitlist(ctx, input(et))
    const mail = await outbox(),
      token = await verification()
    clock = NOW.add({ minutes: 15 })
    await resendWaitlistVerification(ctx, input(et))
    await db
      .updateTable('waitlist_capabilities')
      .set({ revoked_at: null })
      .where('token_hash', '=', waitlistTokenHash(token, 'verification'))
      .execute()
    await expect(verifyWaitlist(ctx, { token })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
    expect(
      await db.transaction().execute((trx) => prepareWaitlistVerification(trx, ctx, mail.id)),
    ).toBeUndefined()
    expect((await entry()).status).toBe('pending_verification')
  })

  it('email hourly cap is shared across events and atomic for the final allowance', async () => {
    const a = await event(),
      b = await event(),
      c = await event()
    await joinWaitlist(ctx, input(a))
    await Promise.all([
      joinWaitlist({ ...ctx, trustedIp: '192.0.2.2' }, input(b)),
      joinWaitlist({ ...ctx, trustedIp: '192.0.2.3' }, input(c)),
    ])
    expect(await countRequests()).toBe(2)
    expect(await db.selectFrom('waitlist_entries').select('id').execute()).toHaveLength(2)
  })

  it('email daily cap is independent of the hourly cap and clears at the rolling equality', async () => {
    const a = await event(),
      b = await event()
    await joinWaitlist(ctx, input(a))
    await db
      .updateTable('waitlist_verification_requests')
      .set({ requested_at: new Date(NOW.epochMilliseconds - 2 * HOUR) })
      .execute()
    await seedRequests(4, {
      requested_at: new Date(NOW.epochMilliseconds - 2 * HOUR),
      ip_hash: Buffer.alloc(32, 2),
    })
    expect(await joinWaitlist({ ...ctx, trustedIp: '192.0.2.9' }, input(b))).toEqual({
      accepted: true,
    })
    expect(await countRequests()).toBe(5)
    clock = NOW.add({ hours: 22 })
    await joinWaitlist({ ...ctx, trustedIp: '192.0.2.9' }, input(b))
    expect(await countRequests()).toBe(6)
  })

  it('IP hourly cap is shared across event/email and IPv6 /64 aliases; final allowance is atomic', async () => {
    const a = await event()
    const ip = '2001:db8:12:34::1'
    await joinWaitlist({ ...ctx, trustedIp: ip }, input(a, 'first@example.test'))
    await seedRequests(3, { email_hash: Buffer.alloc(32, 3), event_type_id: randomUUID() })
    const results = await Promise.allSettled([
      joinWaitlist(
        { ...ctx, trustedIp: '2001:0db8:0012:0034::2' },
        input(a, 'second@example.test'),
      ),
      joinWaitlist({ ...ctx, trustedIp: '2001:db8:12:34:ffff::3' }, input(a, 'third@example.test')),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await countRequests()).toBe(5)
    expect(waitlistIpBucket('2001:db8:12:34::a')).toBe(
      waitlistIpBucket('2001:0db8:12:0034:ffff::1'),
    )
    expect(waitlistIpBucket(undefined)).toBe(waitlistIpBucket('untrusted'))
  })

  it('IP daily cap is enforced independently of its hourly cap', async () => {
    const et = await event()
    await joinWaitlist(ctx, input(et))
    await db
      .updateTable('waitlist_verification_requests')
      .set({ requested_at: new Date(NOW.epochMilliseconds - 2 * HOUR) })
      .execute()
    await seedRequests(19, {
      requested_at: new Date(NOW.epochMilliseconds - 2 * HOUR),
      email_hash: Buffer.alloc(32, 4),
      event_type_id: randomUUID(),
    })
    await expect(joinWaitlist(ctx, input(et, 'new@example.test'))).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 86400,
    })
    expect(await countRequests()).toBe(20)
  })

  it('event hourly cap is shared across email/IP and atomic for the final allowance', async () => {
    const et = await event()
    await joinWaitlist(ctx, input(et))
    await seedRequests(18, { email_hash: Buffer.alloc(32, 5), ip_hash: Buffer.alloc(32, 5) })
    const results = await Promise.all([
      joinWaitlist({ ...ctx, trustedIp: '192.0.2.2' }, input(et, 'two@example.test')),
      joinWaitlist({ ...ctx, trustedIp: '192.0.2.3' }, input(et, 'three@example.test')),
    ])
    expect(results).toEqual([{ accepted: true }, { accepted: true }])
    expect(await countRequests()).toBe(20)
  })

  it('event daily cap is enforced independently of its hourly cap', async () => {
    const et = await event()
    await joinWaitlist(ctx, input(et))
    await db
      .updateTable('waitlist_verification_requests')
      .set({ requested_at: new Date(NOW.epochMilliseconds - 2 * HOUR) })
      .execute()
    await seedRequests(99, {
      requested_at: new Date(NOW.epochMilliseconds - 2 * HOUR),
      email_hash: Buffer.alloc(32, 6),
      ip_hash: Buffer.alloc(32, 6),
    })
    expect(
      await joinWaitlist({ ...ctx, trustedIp: '192.0.2.9' }, input(et, 'next@example.test')),
    ).toEqual({ accepted: true })
    expect(await countRequests()).toBe(100)
  })

  it('event storage cap is atomic and delayed expiry cannot block replacement', async () => {
    const et = await event()
    await joinWaitlist(ctx, input(et))
    const first = await entry()
    await db
      .insertInto('waitlist_entries')
      .values(
        Array.from({ length: 98 }, (_, i) => ({
          ...first,
          id: randomUUID(),
          recipient_hash: waitlistRecipientHash(`stored-${i}@example.test`, ctx.secret),
          email: `stored-${i}@example.test`,
        })),
      )
      .execute()
    await Promise.all([
      joinWaitlist({ ...ctx, trustedIp: '192.0.2.2' }, input(et, 'two@example.test')),
      joinWaitlist({ ...ctx, trustedIp: '192.0.2.3' }, input(et, 'three@example.test')),
    ])
    expect(
      await db
        .selectFrom('waitlist_entries')
        .select('id')
        .where('status', '=', 'pending_verification')
        .execute(),
    ).toHaveLength(100)
    clock = NOW.add({ hours: 24 })
    await joinWaitlist({ ...ctx, trustedIp: '192.0.2.9' }, input(et, 'replacement@example.test'))
    expect(
      await db
        .selectFrom('waitlist_entries')
        .select('id')
        .where('status', '=', 'pending_verification')
        .execute(),
    ).toHaveLength(1)
    expect(
      await db
        .selectFrom('waitlist_entries')
        .select('id')
        .where('status', '=', 'expired')
        .execute(),
    ).toHaveLength(100)
  })

  it('management is purpose-bound, pending can self-view/remove, replay is digest-only and accounting survives', async () => {
    const et = await event()
    await joinWaitlist(ctx, input(et))
    const token = await verification(),
      manage = await management()
    await expect(getWaitlistEntry(ctx, { token })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
    expect((await getWaitlistEntry(ctx, { token: manage })).status).toBe('pending_verification')
    expect(await removeWaitlist(ctx, { token: manage })).toEqual({ removed: true })
    expect(await removeWaitlist(ctx, { token: manage })).toEqual({ removed: true })
    const row = await entry()
    expect([
      row.email,
      row.name,
      row.window_start,
      row.window_end,
      row.time_zone,
      row.locale,
    ]).toEqual([null, null, null, null, null, null])
    expect((await outbox()).encrypted_payload).toBeNull()
    expect(await countRequests()).toBe(1)
    await expect(getWaitlistEntry(ctx, { token: manage })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
    await expect(verifyWaitlist(ctx, { token })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
    await joinWaitlist(ctx, input(et))
    expect(await countRequests()).toBe(2)
    const rows = await db.selectFrom('waitlist_entries').select('id').execute()
    expect(rows).toHaveLength(2)
    expect(rows.some((entry) => entry.id === row.id)).toBe(true)
    clock = NOW.add({ hours: 7 * 24 })
    await expect(removeWaitlist(ctx, { token: manage })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
  })

  it('sender preparation checks generation/lifecycle and mints separate management only on preparation', async () => {
    const et = await event()
    await joinWaitlist(ctx, input(et))
    const mail = await outbox()
    expect(
      await db
        .selectFrom('waitlist_capabilities')
        .select('id')
        .where('purpose', '=', 'management')
        .execute(),
    ).toHaveLength(0)
    const prepared = await db
      .transaction()
      .execute((trx) => prepareWaitlistVerification(trx, ctx, mail.id))
    expect(prepared?.verificationToken === (await verification())).toBe(true)
    expect(prepared?.managementToken === prepared?.verificationToken).toBe(false)
    clock = NOW.add({ minutes: 15 })
    await resendWaitlistVerification(ctx, input(et))
    expect(
      await db.transaction().execute((trx) => prepareWaitlistVerification(trx, ctx, mail.id)),
    ).toBeUndefined()
    if (!prepared) throw new Error('Expected current verification preparation')
    await removeWaitlist(ctx, { token: prepared.managementToken })
    expect(
      await db.transaction().execute((trx) => prepareWaitlistVerification(trx, ctx, mail.id)),
    ).toBeUndefined()
  })

  it('cleanup uses elapsed deadlines across DST, erases contacts and purges bounded operations/accounting', async () => {
    const et = await event()
    await joinWaitlist(ctx, {
      ...input(et),
      preferredWindow: {
        start: '2026-11-02T00:00:00Z',
        end: '2026-12-15T00:00:00Z',
        timeZone: 'Europe/Berlin',
      },
    })
    const token = await verification(),
      manage = await management()
    await verifyWaitlist(ctx, { token })
    expect((await entry()).expires_at.getTime() - NOW.epochMilliseconds).toBe(30 * DAY)
    clock = NOW.add({ hours: 30 * 24 })
    expect(await cleanupWaitlist(ctx, { limit: 1 })).toMatchObject({
      expired: 1,
      erased: 1,
      requests: 1,
    })
    expect((await entry()).email).toBeNull()
    expect(await countRequests()).toBe(0)
    await expect(getWaitlistEntry(ctx, { token: manage })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
    clock = clock.add({ hours: 7 * 24 })
    await cleanupWaitlist(ctx, { limit: 1 })
    expect(await db.selectFrom('waitlist_entries').select('id').execute()).toEqual([])
    expect(await db.selectFrom('waitlist_capabilities').select('id').execute()).toEqual([])
  })

  it('cleanup independently retains future exact-slot tombstones and bounds each purge page', async () => {
    const et = await event()
    const start = new Date(NOW.epochMilliseconds - HOUR),
      end = new Date(NOW.epochMilliseconds - 30 * 60_000)
    await db
      .insertInto('waitlist_slot_tombstones')
      .values(
        [0, 1].map((i) => ({
          event_type_id: et.eventId,
          recipient_hash: Buffer.alloc(32, i + 1),
          start_at: start,
          end_at: end,
          purge_at: new Date(end.getTime() + 2 * DAY),
        })),
      )
      .execute()
    await db
      .insertInto('waitlist_slots')
      .values({ event_type_id: et.eventId, start_at: start, end_at: end, is_open: false })
      .execute()
    clock = NOW.add({ hours: 47 })
    await cleanupWaitlist(ctx, { limit: 1 })
    expect(
      await db
        .selectFrom('waitlist_slot_tombstones')
        .select('recipient_hash')
        .where('event_type_id', '=', et.eventId)
        .execute(),
    ).toHaveLength(2)
    expect(
      await db
        .selectFrom('waitlist_slots')
        .select('start_at')
        .where('event_type_id', '=', et.eventId)
        .execute(),
    ).toHaveLength(0)
    clock = NOW.add({ hours: 48 })
    await cleanupWaitlist(ctx, { limit: 1 })
    expect(
      await db
        .selectFrom('waitlist_slot_tombstones')
        .select('recipient_hash')
        .where('event_type_id', '=', et.eventId)
        .execute(),
    ).toHaveLength(1)
    await cleanupWaitlist(ctx, { limit: 1 })
    expect(
      await db
        .selectFrom('waitlist_slot_tombstones')
        .select('recipient_hash')
        .where('event_type_id', '=', et.eventId)
        .execute(),
    ).toHaveLength(0)
  })

  it('secret rotation retires live contacts and ciphertext before new requests while preserving accounting', async () => {
    const et = await event()
    await joinWaitlist(ctx, input(et))
    const token = await verification(),
      manage = await management()
    await db
      .transaction()
      .execute((trx) =>
        ensureWaitlistKey(trx, 'new-synthetic-secret', new Date(NOW.epochMilliseconds)),
      )
    const row = await entry()
    expect(row.status).toBe('removed')
    expect(row.terminal_reason).toBe('secret_rotated')
    expect([row.email, row.name, row.window_start, row.time_zone, row.locale]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ])
    expect(await db.selectFrom('waitlist_verification_outbox').select('id').execute()).toEqual([])
    expect(await db.selectFrom('waitlist_capabilities').select('id').execute()).toEqual([])
    expect(await countRequests()).toBe(1)
    const rotated = { ...ctx, secret: 'new-synthetic-secret' }
    await expect(verifyWaitlist(rotated, { token })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
    await expect(getWaitlistEntry(rotated, { token: manage })).rejects.toMatchObject({
      code: 'invalid_waitlist_token',
    })
    await joinWaitlist(rotated, input(et))
    expect(await countRequests()).toBe(2)
    expect(
      await db
        .selectFrom('waitlist_entries')
        .select('id')
        .where('status', '=', 'pending_verification')
        .execute(),
    ).toHaveLength(1)
  })
})
