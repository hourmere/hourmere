import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ApiKeyScopeError, InvalidApiKeyError, type Principal } from '@hourmere/auth'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql, type Transaction } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cancelHostBooking } from './bookings.ts'
import { DomainError } from './errors.ts'
import * as Links from './one-time-links.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = () => Temporal.Instant.from('2026-01-01T00:00:00Z')
type LinkModule = typeof Links

/** Imports only an isolated copy. Production service files are never overwritten. */
async function sourceCopy(replacement?: readonly [string, string]): Promise<LinkModule> {
  const location = new URL('./one-time-links.ts', import.meta.url)
  const original = readFileSync(location, 'utf8')
  if (replacement)
    expect(original.includes(replacement[0]), 'mutation must match source').toBe(true)
  const modified = replacement ? original.replace(...replacement) : original
  const source = stripTypeScriptTypes(modified).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

/** Keep capability values out of matcher diagnostics, including intentional failures. */
function noCapability(value: unknown, token: string, hash?: string) {
  const serialized = JSON.stringify(value) ?? 'null'
  expect(serialized.includes(token)).toBe(false)
  expect(hash ? serialized.includes(hash) : false).toBe(false)
  expect(/token_hash|tokenHash|manage_token|manageToken/.test(serialized)).toBe(false)
}

async function failure(fn: () => Promise<unknown>) {
  const error = await fn().then(
    () => null,
    (error: unknown) => error,
  )
  expect(
    typeof error === 'object' && error !== null && (error as Error).name === 'DomainError',
  ).toBe(true)
  const domain = error as DomainError
  return { kind: domain.kind, code: domain.code, detail: domain.detail, message: domain.message }
}

function session(principal: Principal): Principal {
  return {
    kind: 'session',
    sessionId: randomUUID(),
    user: principal.user,
    organization: principal.organization,
  }
}

describe.skipIf(!serverUrl)('one-time booking link service', () => {
  let owned: TestDatabase
  let db: Db
  let fixtures: ReturnType<typeof createFixtures>
  let bookingSequence = 0

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'one_time_links' })
    db = createDb(owned.pool)
    fixtures = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup() {
    const user = await createTestUser(db)
    const ctx = testContext(db, session(user.principal), NOW)
    const eventTypeId = await fixtures.eventType(user.principal.organization.id, user.id)
    return { user, ctx, eventTypeId, organizationId: user.principal.organization.id }
  }

  async function booking(
    s: Awaited<ReturnType<typeof setup>>,
    options: Parameters<typeof fixtures.booking>[4] = {},
  ) {
    const start = Temporal.Instant.from('2036-11-02T10:00:00Z').add({ hours: bookingSequence++ })
    return fixtures.booking(
      s.organizationId,
      [s.user.id],
      start.toString(),
      start.add({ minutes: 30 }).toString(),
      { eventTypeId: s.eventTypeId, ...options },
    )
  }

  async function insertBooking(
    trx: Transaction<Database>,
    s: Awaited<ReturnType<typeof setup>>,
    options: Parameters<typeof fixtures.booking>[4] = {},
  ) {
    const start = Temporal.Instant.from('2036-11-02T10:00:00Z').add({ hours: bookingSequence++ })
    const row = await trx
      .insertInto('bookings')
      .values({
        organization_id: s.organizationId,
        event_type_id: options.eventTypeId ?? s.eventTypeId,
        status: options.status ?? 'confirmed',
        cancelled_at: options.status === 'cancelled' ? new Date() : null,
        start_at: start.toString(),
        end_at: start.add({ minutes: 30 }).toString(),
        title: 'One-time booking',
        manage_token_hash: createHash('sha256').update(randomBytes(32)).digest(),
        source: 'web',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('booking_hosts')
      .values({ booking_id: row.id, user_id: s.user.id })
      .execute()
    const attendee = options.attendee ?? { name: 'Invitee', email: 'invitee@example.com' }
    await trx
      .insertInto('booking_attendees')
      .values({ booking_id: row.id, ...attendee, time_zone: 'UTC', is_booker: true })
      .execute()
    return row
  }

  async function bookAndClaim(
    s: Awaited<ReturnType<typeof setup>>,
    token: string,
    options: Parameters<typeof fixtures.booking>[4] = {},
    module = Links,
  ) {
    return db.transaction().execute(async (trx) => {
      const row = await insertBooking(trx, s, options)
      return module.claimOneTimeBookingLink(trx, token, row.id)
    })
  }

  const storedLink = (id: string) =>
    db
      .selectFrom('one_time_booking_links')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  const resolve = (token: string | undefined, module = Links) =>
    module.resolveOneTimeBookingLink({ db }, token)
  const claim = (token: string | undefined, bookingId: string, module = Links) =>
    db.transaction().execute((trx) => module.claimOneTimeBookingLink(trx, token, bookingId))
  async function unavailable(token: string | undefined, bookingId: string, module = Links) {
    const expected = {
      kind: 'not_found',
      code: 'one_time_link_not_found',
    }
    const resolution = await failure(() => resolve(token, module))
    const consumption = await failure(() => claim(token, bookingId, module))
    expect(resolution).toMatchObject(expected)
    expect(consumption).toEqual(resolution)
    return resolution
  }

  it('returns the random capability only at creation, storing a SHA-256 digest and safe metadata', async () => {
    const s = await setup()
    const created = await Links.createOneTimeBookingLink(s.ctx, {
      eventTypeId: s.eventTypeId,
      prefill: { name: '  Grace Hopper  ', email: '  GRACE@example.com  ' },
    })
    expect(/^[A-Za-z0-9_-]{43}$/.test(created.token)).toBe(true)
    const second = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    expect(created.token === second.token).toBe(false)
    const hash = createHash('sha256').update(created.token).digest('hex')
    const stored = await db
      .selectFrom('one_time_booking_links')
      .selectAll()
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow()
    expect(stored.token_hash === hash).toBe(true)
    expect(JSON.stringify(stored).includes(created.token)).toBe(false)
    const metadata = { ...created, token: undefined }
    expect(metadata).toMatchObject({
      eventTypeId: s.eventTypeId,
      organizationId: s.organizationId,
      creatorUserId: s.user.id,
      expiresAt: null,
      prefill: { name: 'Grace Hopper', email: 'grace@example.com' },
      state: 'active',
      bookingId: null,
      usedAt: null,
      revokedAt: null,
    })
    expect(JSON.stringify(created).includes(hash)).toBe(false)
    const resolved = await resolve(created.token)
    noCapability(resolved, created.token, hash)
    expect(resolved).toEqual({
      id: created.id,
      eventTypeId: s.eventTypeId,
      organizationId: s.organizationId,
      prefill: { name: 'Grace Hopper', email: 'grace@example.com' },
    })
    const revoked = await Links.revokeOneTimeBookingLink(s.ctx, created.id)
    noCapability(revoked, created.token, hash)
  })

  it('treats absent prefill as optional suggestions rather than booking identity proof', async () => {
    const s = await setup()
    const link = await Links.createOneTimeBookingLink(s.ctx, {
      eventTypeId: s.eventTypeId,
      prefill: { name: null, email: 'suggestion@example.com' },
    })
    const claimed = await bookAndClaim(s, link.token, {
      attendee: { name: 'Different invitee', email: 'different@example.com' },
    })
    expect(claimed.state).toBe('used')
    noCapability(claimed, link.token)
    expect(
      (
        await resolve(
          (
            await Links.createOneTimeBookingLink(s.ctx, {
              eventTypeId: s.eventTypeId,
            })
          ).token,
        )
      ).prefill,
    ).toEqual({ name: null, email: null })
  })

  it('returns one uniform failure for unknown, malformed, expired, revoked and used tokens', async () => {
    const s = await setup()
    const bookingId = await booking(s)
    const used = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    await bookAndClaim(s, used.token)
    const revoked = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    await Links.revokeOneTimeBookingLink(s.ctx, revoked.id)
    const expiredToken = randomBytes(32).toString('base64url')
    await db
      .insertInto('one_time_booking_links')
      .values({
        organization_id: s.organizationId,
        event_type_id: s.eventTypeId,
        creator_user_id: s.user.id,
        token_hash: createHash('sha256').update(expiredToken).digest('hex'),
        expires_at: sql`clock_timestamp() - interval '1 second'`,
      })
      .execute()
    const baseline = await unavailable(randomBytes(32).toString('base64url'), bookingId)
    for (const token of [
      undefined,
      '',
      'bad-token',
      'a'.repeat(44),
      used.token,
      revoked.token,
      expiredToken,
    ]) {
      expect(await unavailable(token, bookingId)).toEqual(baseline)
    }
    expect(
      await db
        .selectFrom('one_time_booking_links')
        .select('id')
        .where('id', 'in', [used.id, revoked.id])
        .execute(),
    ).toHaveLength(2)
  })

  it('uses the database clock for creation, ignoring the injected service clock', async () => {
    const s = await setup()
    const dbTime = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db)
    const future = new Date((dbTime.rows[0]?.now.getTime() as number) + 3_600_000).toISOString()
    const farFuture = { ...s.ctx, now: () => Temporal.Instant.from('2099-01-01T00:00:00Z') }
    const created = await Links.createOneTimeBookingLink(farFuture, {
      eventTypeId: s.eventTypeId,
      expiresAt: future,
    })
    expect(created.expiresAt).toBe(future)
    expect((await resolve(created.token)).id).toBe(created.id)
    const past = new Date((dbTime.rows[0]?.now.getTime() as number) - 1000).toISOString()
    expect(
      await failure(() =>
        Links.createOneTimeBookingLink(s.ctx, {
          eventTypeId: s.eventTypeId,
          expiresAt: past,
        }),
      ),
    ).toMatchObject({ kind: 'invalid', code: 'invalid_one_time_link' })
  })

  it('expires by current database wall time even inside a transaction begun before expiry', async () => {
    const s = await setup()
    const bookingId = await booking(s)
    const expiry = await sql<{
      expires: Date
    }>`select clock_timestamp() + interval '500 milliseconds' as expires`.execute(db)
    const link = await Links.createOneTimeBookingLink(s.ctx, {
      eventTypeId: s.eventTypeId,
      expiresAt: expiry.rows[0]?.expires.toISOString(),
    })
    await db.transaction().execute(async (trx) => {
      await sql`select transaction_timestamp()`.execute(trx)
      await sql`select pg_sleep(greatest(0, extract(epoch from (${link.expiresAt}::timestamptz - clock_timestamp()))) + 0.02)`.execute(
        trx,
      )
      expect(
        await failure(() => Links.resolveOneTimeBookingLink({ db: trx }, link.token)),
      ).toMatchObject({ code: 'one_time_link_not_found' })
      expect(
        await failure(() => Links.claimOneTimeBookingLink(trx, link.token, bookingId)),
      ).toMatchObject({ code: 'one_time_link_not_found' })
    })
    expect(await Links.revokeOneTimeBookingLink(s.ctx, link.id)).toBeUndefined()
    expect((await storedLink(link.id)).state).toBe('active')
  })

  it('allows hidden event types and refuses inactive or deleted event types uniformly', async () => {
    const s = await setup()
    await db
      .updateTable('event_types')
      .set({ is_hidden: true })
      .where('id', '=', s.eventTypeId)
      .execute()
    const link = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    const bookingId = await booking(s)
    expect((await resolve(link.token)).id).toBe(link.id)
    await db
      .updateTable('event_types')
      .set({ is_active: false })
      .where('id', '=', s.eventTypeId)
      .execute()
    await unavailable(link.token, bookingId)
    expect(
      await failure(() => Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })),
    ).toMatchObject({ code: 'event_type_inactive' })
    await db
      .updateTable('event_types')
      .set({ is_active: true, deleted_at: new Date() })
      .where('id', '=', s.eventTypeId)
      .execute()
    await unavailable(link.token, bookingId)
    expect(
      await failure(() => Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })),
    ).toMatchObject({ code: 'event_type_inactive' })
  })

  it('revokes idempotently, preserves the original timestamps and blocks resolution and consumption', async () => {
    const s = await setup()
    const link = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    expect(await Links.revokeOneTimeBookingLink(s.ctx, link.id)).toBeUndefined()
    const first = await storedLink(link.id)
    expect(first.state).toBe('revoked')
    expect(first.revoked_at !== null).toBe(true)
    expect(await Links.revokeOneTimeBookingLink(s.ctx, link.id)).toBeUndefined()
    const again = await storedLink(link.id)
    expect(again.revoked_at).toEqual(first.revoked_at)
    expect(again.updated_at).toEqual(first.updated_at)
    await unavailable(link.token, await booking(s))
  })

  it('commits consumption with the booking transaction and does not reactivate after real cancellation', async () => {
    const s = await setup()
    const link = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    const claimed = await bookAndClaim(s, link.token)
    const bookingId = claimed.bookingId as string
    expect(claimed).toMatchObject({ state: 'used', bookingId })
    expect(claimed.usedAt !== null).toBe(true)
    await cancelHostBooking(s.ctx, bookingId)
    const stored = await db
      .selectFrom('one_time_booking_links')
      .select(['state', 'booking_id', 'used_at'])
      .where('id', '=', link.id)
      .executeTakeFirstOrThrow()
    expect(stored).toMatchObject({ state: 'used', booking_id: bookingId })
    expect(stored.used_at?.toISOString()).toBe(claimed.usedAt)
    await unavailable(link.token, bookingId)
    expect(await Links.revokeOneTimeBookingLink(s.ctx, link.id)).toBeUndefined()
    expect(await storedLink(link.id)).toMatchObject({ state: 'used', booking_id: bookingId })
  })

  it('rolls consumption and its new booking back together, allowing one later successful claim', async () => {
    const s = await setup()
    const link = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    let rolledBackId: string | undefined
    const rollback = new Error('deliberate transaction rollback')
    await expect(
      db.transaction().execute(async (trx) => {
        const row = await insertBooking(trx, s)
        rolledBackId = row.id
        await Links.claimOneTimeBookingLink(trx, link.token, row.id)
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('id', '=', rolledBackId as string)
        .execute(),
    ).toEqual([])
    expect((await resolve(link.token)).id).toBe(link.id)
    const committed = await db.transaction().execute(async (trx) => {
      const row = await insertBooking(trx, s)
      await Links.claimOneTimeBookingLink(trx, link.token, row.id)
      return row.id
    })
    expect(
      (
        await db
          .selectFrom('one_time_booking_links')
          .select('booking_id')
          .where('id', '=', link.id)
          .executeTakeFirstOrThrow()
      ).booking_id,
    ).toBe(committed)
  })

  it('lets exactly one of two concurrent booking transactions consume the same capability', async () => {
    const s = await setup()
    const link = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    const ids: string[] = []
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived = 0
    const attempt = () =>
      db.transaction().execute(async (trx) => {
        const row = await insertBooking(trx, s)
        ids.push(row.id)
        if (++arrived === 2) release()
        await ready
        return Links.claimOneTimeBookingLink(trx, link.token, row.id)
      })
    const outcomes = await Promise.allSettled([attempt(), attempt()])
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const failed = outcomes.find((result) => result.status === 'rejected')
    expect(
      failed?.status === 'rejected' &&
        failed.reason instanceof DomainError &&
        failed.reason.code === 'one_time_link_not_found',
    ).toBe(true)
    const bookings = await db.selectFrom('bookings').select('id').where('id', 'in', ids).execute()
    expect(bookings).toHaveLength(1)
    const linkRow = await db
      .selectFrom('one_time_booking_links')
      .select(['state', 'booking_id'])
      .where('id', '=', link.id)
      .executeTakeFirstOrThrow()
    expect(linkRow).toEqual({ state: 'used', booking_id: bookings[0]?.id })
    expect(owned.pool.totalCount).toBeLessThan(10)
  }, 20_000)

  it('requires a transaction and a confirmed booking for the exact event type and organization', async () => {
    const s = await setup()
    const other = await setup()
    const sameOrganizationEvent = await fixtures.eventType(s.organizationId, s.user.id)
    const badIds = [
      randomUUID(),
      'malformed',
      await booking(other),
      await booking(s, { eventTypeId: sameOrganizationEvent }),
      await booking(s, { status: 'cancelled' }),
    ]
    for (const bookingId of badIds) {
      const link = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
      expect(await failure(() => claim(link.token, bookingId))).toMatchObject({
        code: 'one_time_link_not_found',
      })
      expect((await resolve(link.token)).id).toBe(link.id)
    }
    const link = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    await expect(
      Links.claimOneTimeBookingLink(db as Transaction<Database>, link.token, await booking(s)),
    ).rejects.toBeInstanceOf(TypeError)
  })

  it('does not attach two links to one confirmed booking, keeping the unsuccessful link available', async () => {
    const s = await setup()
    const first = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    const second = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    await db.transaction().execute(async (trx) => {
      const { id: bookingId } = await insertBooking(trx, s)
      await Links.claimOneTimeBookingLink(trx, first.token, bookingId)
      await sql`SAVEPOINT second_claim`.execute(trx)
      expect(
        await failure(() => Links.claimOneTimeBookingLink(trx, second.token, bookingId)),
      ).toMatchObject({
        code: 'one_time_link_not_found',
      })
      await sql`ROLLBACK TO SAVEPOINT second_claim`.execute(trx)
    })
    expect((await resolve(second.token)).id).toBe(second.id)
  })

  async function verifyNewBooking(
    module: LinkModule,
    updateExisting = false,
    matchCreatedAtFromOtherTransaction = false,
  ) {
    const s = await setup()
    const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    const bookingId = await booking(s)
    let attemptedWrite = false
    await db.transaction().execute(async (trx) => {
      if (matchCreatedAtFromOtherTransaction) {
        // Preserve PostgreSQL's full timestamp precision while isolating the xmin guard.
        const { startedAt } = await trx
          .selectNoFrom(sql<string>`transaction_timestamp()::text`.as('startedAt'))
          .executeTakeFirstOrThrow()
        await db
          .updateTable('bookings')
          .set({ created_at: sql<Date>`${startedAt}::timestamptz` })
          .where('id', '=', bookingId)
          .execute()
      }
      if (updateExisting)
        await trx
          .updateTable('bookings')
          .set({ title: 'Existing booking edited' })
          .where('id', '=', bookingId)
          .execute()
      const observed = trx.withPlugin({
        transformQuery: ({ node }) => {
          if (node.kind === 'UpdateQueryNode') attemptedWrite = true
          return node
        },
        transformResult: async ({ result }) => result,
      })
      const outcome = await module.claimOneTimeBookingLink(observed, link.token, bookingId).then(
        () => 'fulfilled',
        (error: unknown) =>
          (error as { name?: string; code?: string })?.name === 'DomainError'
            ? (error as { code: string }).code
            : 'unexpected',
      )
      expect(outcome).toBe('one_time_link_not_found')
      expect(attemptedWrite).toBe(false)
    })
    expect((await resolve(link.token)).id).toBe(link.id)
  }

  it('rejects a previously committed booking before attempting a claim write', async () => {
    await verifyNewBooking(Links)
  })

  it('rejects an existing booking even if it was updated in the claiming transaction', async () => {
    await verifyNewBooking(Links, true)
  })

  async function verifyOverlappingBooking(module: LinkModule) {
    const s = await setup()
    const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    await db.transaction().execute(async (trx) => {
      // Force this transaction to start before the separate booking transaction.
      await sql`select transaction_timestamp()`.execute(trx)
      const { id: bookingId } = await db.transaction().execute((other) => insertBooking(other, s))
      const timing = await trx
        .selectFrom('bookings')
        .select(sql<boolean>`created_at > transaction_timestamp()`.as('later'))
        .where('id', '=', bookingId)
        .executeTakeFirstOrThrow()
      expect(timing.later).toBe(true)
      await trx
        .updateTable('bookings')
        .set({ title: 'Later booking edited by first transaction' })
        .where('id', '=', bookingId)
        .execute()
      let attemptedWrite = false
      const observed = trx.withPlugin({
        transformQuery: ({ node }) => {
          if (node.kind === 'UpdateQueryNode') attemptedWrite = true
          return node
        },
        transformResult: async ({ result }) => result,
      })
      const outcome = await module.claimOneTimeBookingLink(observed, link.token, bookingId).then(
        () => 'fulfilled',
        (error: unknown) =>
          (error as { name?: string; code?: string })?.name === 'DomainError'
            ? (error as { code: string }).code
            : 'unexpected',
      )
      expect(outcome).toBe('one_time_link_not_found')
      expect(attemptedWrite).toBe(false)
    })
    expect((await resolve(link.token)).id).toBe(link.id)
  }

  it('rejects a booking committed by a later transaction even after updating it in the claiming transaction', async () => {
    await verifyOverlappingBooking(Links)
  })

  it('keeps active and used team links after their creating admin deletes their account', async () => {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
    ])
    const eventTypeId = await fixtures.eventType(team.id, null)
    const ctx = testContext(db, session(team.as(admin)), NOW)
    const s = { user: owner, ctx, eventTypeId, organizationId: team.id }
    const used = await Links.createOneTimeBookingLink(ctx, { eventTypeId })
    const active = await Links.createOneTimeBookingLink(ctx, { eventTypeId })
    const previous = await bookAndClaim(s, used.token)
    await db.deleteFrom('auth.user').where('id', '=', admin.id).execute()
    expect((await resolve(active.token)).id).toBe(active.id)
    expect(await storedLink(used.id)).toMatchObject({
      state: 'used',
      booking_id: previous.bookingId,
      creator_user_id: admin.id,
    })
    const next = await bookAndClaim(s, active.token)
    expect(next).toMatchObject({ state: 'used', creatorUserId: admin.id })
    expect(next.bookingId).not.toBe(previous.bookingId)
  })

  async function verifyUniformRevoke(module: LinkModule) {
    const owner = await createTestUser(db)
    const member = await createTestUser(db)
    const other = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
      { user: other, role: 'member' },
    ])
    const ownEvent = await fixtures.eventType(team.id, member.id)
    const otherEvent = await fixtures.eventType(team.id, other.id)
    const teamEvent = await fixtures.eventType(team.id, null)
    const ctx = testContext(db, session(team.as(member)), NOW)
    const revoked = await module.createOneTimeBookingLink(ctx, { eventTypeId: ownEvent })
    await module.revokeOneTimeBookingLink(ctx, revoked.id)
    const used = await module.createOneTimeBookingLink(ctx, { eventTypeId: ownEvent })
    await bookAndClaim(
      { user: member, ctx, organizationId: team.id, eventTypeId: ownEvent },
      used.token,
      {},
      module,
    )
    const foreign = await setup()
    const foreignLink = await module.createOneTimeBookingLink(foreign.ctx, {
      eventTypeId: foreign.eventTypeId,
    })
    const unauthorized = await module.createOneTimeBookingLink(
      testContext(db, session(team.as(other)), NOW),
      { eventTypeId: otherEvent },
    )
    const teamLink = await module.createOneTimeBookingLink(
      testContext(db, session(team.as(owner)), NOW),
      { eventTypeId: teamEvent },
    )
    const expired = await db
      .insertInto('one_time_booking_links')
      .values({
        organization_id: team.id,
        event_type_id: ownEvent,
        creator_user_id: member.id,
        token_hash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        expires_at: sql`clock_timestamp() - interval '1 day'`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    let baseline: string[] | undefined
    for (const id of [
      revoked.id,
      randomUUID(),
      foreignLink.id,
      unauthorized.id,
      teamLink.id,
      used.id,
      expired.id,
      'invalid',
    ]) {
      const shapes: string[] = []
      const observed = db.withPlugin({
        transformQuery: ({ node }) => {
          shapes.push(
            JSON.stringify(node, (key, value) => (key === 'value' ? '<parameter>' : value)),
          )
          return node
        },
        transformResult: async ({ result }) => result,
      })
      const result = await module.revokeOneTimeBookingLink({ ...ctx, db: observed }, id).then(
        (value) => ({ fulfilled: true, empty: value === undefined }),
        () => ({ fulfilled: false, empty: false }),
      )
      expect(result).toEqual({ fulfilled: true, empty: true })
      if (baseline) expect(shapes).toEqual(baseline)
      else baseline = shapes
    }
    expect((await storedLink(unauthorized.id)).state).toBe('active')
    expect((await storedLink(teamLink.id)).state).toBe('active')
    expect((await storedLink(foreignLink.id)).state).toBe('active')
    expect((await storedLink(used.id)).state).toBe('used')
  }

  it('acknowledges absent, foreign, inaccessible and terminal revoke IDs through the same query path', async () => {
    await verifyUniformRevoke(Links)
  })

  it('uses the persisted personal owner marker instead of a caller-supplied space flag', async () => {
    const s = await setup()
    const intruder = await createTestUser(db)
    await db
      .insertInto('auth.member')
      .values({
        organizationId: s.organizationId,
        userId: intruder.id,
        role: 'admin',
        createdAt: new Date(),
      })
      .execute()
    const ctx = testContext(
      db,
      {
        ...session(intruder.principal),
        organization: { ...s.ctx.principal.organization, personal: false },
      },
      NOW,
    )
    expect(
      await failure(() => Links.createOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId })),
    ).toMatchObject({ code: 'insufficient_role' })
  })

  it('restricts personal links to their owning user and current organization', async () => {
    const s = await setup()
    const other = await setup()
    const link = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    expect(
      await failure(() =>
        Links.createOneTimeBookingLink(other.ctx, { eventTypeId: s.eventTypeId }),
      ),
    ).toMatchObject({ code: 'event_type_not_found' })
    expect(await Links.revokeOneTimeBookingLink(other.ctx, link.id)).toBeUndefined()
    expect(
      await failure(() => Links.createOneTimeBookingLink(s.ctx, { eventTypeId: 'bad-id' })),
    ).toMatchObject({ code: 'event_type_not_found' })
    expect(await Links.revokeOneTimeBookingLink(s.ctx, 'bad-id')).toBeUndefined()
  })

  it('allows team owners/admins for team events and members only for their own events', async () => {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const other = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
      { user: other, role: 'member' },
    ])
    const ctx = (user: typeof owner) => testContext(db, session(team.as(user)), NOW)
    const eventTypeId = await fixtures.eventType(team.id, null)
    const ownEventTypeId = await fixtures.eventType(team.id, member.id)
    const otherEventTypeId = await fixtures.eventType(team.id, other.id)
    for (const user of [owner, admin]) {
      const link = await Links.createOneTimeBookingLink(ctx(user), { eventTypeId })
      expect(
        await Links.revokeOneTimeBookingLink(ctx(user === owner ? admin : owner), link.id),
      ).toBeUndefined()
      expect((await storedLink(link.id)).state).toBe('revoked')
    }
    expect(
      await failure(() => Links.createOneTimeBookingLink(ctx(member), { eventTypeId })),
    ).toMatchObject({ kind: 'forbidden', code: 'insufficient_role' })
    const teamLink = await Links.createOneTimeBookingLink(ctx(owner), { eventTypeId })
    expect(await Links.revokeOneTimeBookingLink(ctx(member), teamLink.id)).toBeUndefined()
    expect((await storedLink(teamLink.id)).state).toBe('active')
    const own = await Links.createOneTimeBookingLink(ctx(member), { eventTypeId: ownEventTypeId })
    expect(await Links.revokeOneTimeBookingLink(ctx(member), own.id)).toBeUndefined()
    expect((await storedLink(own.id)).state).toBe('revoked')
    expect(
      await failure(() =>
        Links.createOneTimeBookingLink(ctx(member), { eventTypeId: otherEventTypeId }),
      ),
    ).toMatchObject({ code: 'event_type_not_found' })
  })

  it('rechecks database roles, membership and verification after principal resolution', async () => {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
    ])
    const ctx = testContext(db, session(team.as(admin)), NOW)
    const eventTypeId = await fixtures.eventType(team.id, null)
    const link = await Links.createOneTimeBookingLink(ctx, { eventTypeId })
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    expect(await failure(() => Links.createOneTimeBookingLink(ctx, { eventTypeId }))).toMatchObject(
      { code: 'insufficient_role' },
    )
    expect(await Links.revokeOneTimeBookingLink(ctx, link.id)).toBeUndefined()
    expect((await storedLink(link.id)).state).toBe('active')
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    expect(await failure(() => Links.createOneTimeBookingLink(ctx, { eventTypeId }))).toMatchObject(
      { kind: 'forbidden' },
    )
    expect(await Links.revokeOneTimeBookingLink(ctx, link.id)).toBeUndefined()
    expect((await storedLink(link.id)).state).toBe('active')
    const s = await setup()
    const personalLink = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', s.user.id)
      .execute()
    expect(
      await failure(() => Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })),
    ).toMatchObject({ kind: 'forbidden' })
    expect(
      await failure(() => Links.revokeOneTimeBookingLink(s.ctx, personalLink.id)),
    ).toMatchObject({ kind: 'forbidden' })
  })

  it('makes links unavailable when their personal event owner leaves or loses email proof', async () => {
    const s = await setup()
    const link = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    const bookingId = await booking(s)
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', s.organizationId)
      .where('userId', '=', s.user.id)
      .execute()
    await unavailable(link.token, bookingId)
    await db
      .insertInto('auth.member')
      .values({
        organizationId: s.organizationId,
        userId: s.user.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    expect((await resolve(link.token)).id).toBe(link.id)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', s.user.id)
      .execute()
    await unavailable(link.token, bookingId)
  })

  it('requires full API-key scope and revalidates the persisted full key before configuration writes', async () => {
    const s = await setup()
    const link = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    for (const apiKeyScope of ['read', 'bookings'] as const) {
      const ctx = testContext(
        db,
        { ...s.user.principal, kind: 'api_key', apiKeyId: randomUUID(), apiKeyScope },
        NOW,
      )
      await expect(
        Links.createOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId }),
      ).rejects.toBeInstanceOf(ApiKeyScopeError)
      await expect(Links.revokeOneTimeBookingLink(ctx, link.id)).rejects.toBeInstanceOf(
        ApiKeyScopeError,
      )
    }
    const key = await db
      .insertInto('auth.apikey')
      .values({
        configId: 'default',
        referenceId: s.user.id,
        key: createHash('sha256').update(randomBytes(32)).digest('hex'),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: JSON.stringify({ scope: 'full', organizationId: s.organizationId }),
        enabled: true,
        expiresAt: null,
        lastRefillAt: null,
        lastRequest: null,
        name: null,
        permissions: null,
        prefix: null,
        rateLimitEnabled: false,
        rateLimitMax: null,
        rateLimitTimeWindow: null,
        refillAmount: null,
        refillInterval: null,
        remaining: null,
        requestCount: null,
        start: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const ctx = testContext(
      db,
      { ...s.user.principal, kind: 'api_key', apiKeyId: key.id, apiKeyScope: 'full' },
      NOW,
    )
    const full = await Links.createOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId })
    expect(await Links.revokeOneTimeBookingLink(ctx, full.id)).toBeUndefined()
    expect((await storedLink(full.id)).state).toBe('revoked')
    await db.updateTable('auth.apikey').set({ enabled: false }).where('id', '=', key.id).execute()
    await expect(
      Links.createOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId }),
    ).rejects.toBeInstanceOf(InvalidApiKeyError)
    await expect(Links.revokeOneTimeBookingLink(ctx, link.id)).rejects.toBeInstanceOf(
      InvalidApiKeyError,
    )
  })

  it.each([
    { expiresAt: 'not-an-instant' },
    { expiresAt: '2026-01-01' },
    { prefill: null },
    { prefill: [] },
    { prefill: { name: 'A\nB' } },
    { prefill: { name: 'a'.repeat(201) } },
    { prefill: { email: 'not-an-email' } },
    { prefill: { email: 'a\r@example.com' } },
    { prefill: { name: 42 } },
    { prefill: { extra: 'not a supported field' } },
  ])('rejects invalid issuance options %#', async (options) => {
    const s = await setup()
    expect(
      await failure(() =>
        Links.createOneTimeBookingLink(s.ctx, {
          eventTypeId: s.eventTypeId,
          ...options,
        } as Parameters<typeof Links.createOneTimeBookingLink>[1]),
      ),
    ).toMatchObject({ kind: 'invalid', code: 'invalid_one_time_link' })
    expect(
      await db
        .selectFrom('one_time_booking_links')
        .select('id')
        .where('event_type_id', '=', s.eventTypeId)
        .execute(),
    ).toHaveLength(0)
  })

  async function apiKey(s: Awaited<ReturnType<typeof setup>>, scope: 'full' | 'read' | 'bookings') {
    const key = await db
      .insertInto('auth.apikey')
      .values({
        configId: 'default',
        referenceId: s.user.id,
        key: createHash('sha256').update(randomBytes(32)).digest('hex'),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: JSON.stringify({ scope, organizationId: s.organizationId }),
        enabled: true,
        expiresAt: null,
        lastRefillAt: null,
        lastRequest: null,
        name: null,
        permissions: null,
        prefix: null,
        rateLimitEnabled: false,
        rateLimitMax: null,
        rateLimitTimeWindow: null,
        refillAmount: null,
        refillInterval: null,
        remaining: null,
        requestCount: null,
        start: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return {
      keyId: key.id,
      ctx: testContext(
        db,
        { ...s.user.principal, kind: 'api_key', apiKeyId: key.id, apiKeyScope: scope },
        NOW,
      ),
    }
  }

  async function fillCapacity(s: Awaited<ReturnType<typeof setup>>, count: number) {
    await sql`insert into one_time_booking_links (organization_id, event_type_id, creator_user_id, token_hash)
      select ${s.organizationId}::uuid, ${s.eventTypeId}::uuid, ${s.user.id}::uuid,
      encode(sha256(('synthetic-capacity-' || ${randomUUID()} || n::text)::bytea), 'hex')
      from generate_series(1, ${count}) n`.execute(db)
  }

  it('enforces the owner-wide limit across event types and serializes two final-capacity creations', async () => {
    const s = await setup()
    await fillCapacity(s, Links.ONE_TIME_BOOKING_LINK_LIMIT - 1)
    const otherEvent = await fixtures.eventType(s.organizationId, s.user.id)
    const attempts = await Promise.allSettled([
      Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId }),
      Links.createOneTimeBookingLink(s.ctx, { eventTypeId: otherEvent }),
    ])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const failed = attempts.find((result) => result.status === 'rejected')
    expect(
      failed?.status === 'rejected' &&
        failed.reason instanceof DomainError &&
        failed.reason.code === 'one_time_link_limit_reached',
    ).toBe(true)
    expect(
      await failure(() => Links.createOneTimeBookingLink(s.ctx, { eventTypeId: otherEvent })),
    ).toMatchObject({ kind: 'conflict', code: 'one_time_link_limit_reached' })
    const first = await db
      .selectFrom('one_time_booking_links')
      .select('id')
      .where('organization_id', '=', s.organizationId)
      .executeTakeFirstOrThrow()
    await Links.revokeOneTimeBookingLink(s.ctx, first.id)
    expect((await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: otherEvent })).state).toBe(
      'active',
    )
    expect(
      await db
        .selectFrom('one_time_booking_links')
        .select('id')
        .where('organization_id', '=', s.organizationId)
        .execute(),
    ).toHaveLength(Links.ONE_TIME_BOOKING_LINK_LIMIT + 1)
  }, 20_000)

  it('shares team capacity across creators and team event types', async () => {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
    ])
    const eventTypeId = await fixtures.eventType(team.id, null)
    const secondEventTypeId = await fixtures.eventType(team.id, null)
    await sql`insert into one_time_booking_links (organization_id, event_type_id, creator_user_id, token_hash)
      select ${team.id}::uuid, ${eventTypeId}::uuid, ${owner.id}::uuid,
      encode(sha256(('synthetic-team-capacity-' || ${randomUUID()} || n::text)::bytea), 'hex')
      from generate_series(1, ${Links.ONE_TIME_BOOKING_LINK_LIMIT}) n`.execute(db)
    const ctx = testContext(db, session(team.as(admin)), NOW)
    expect(
      await failure(() => Links.createOneTimeBookingLink(ctx, { eventTypeId: secondEventTypeId })),
    ).toMatchObject({ code: 'one_time_link_limit_reached' })
    const retained = await db
      .selectFrom('one_time_booking_links')
      .select('id')
      .where('organization_id', '=', team.id)
      .executeTakeFirstOrThrow()
    await Links.revokeOneTimeBookingLink(ctx, retained.id)
    expect(
      (await Links.createOneTimeBookingLink(ctx, { eventTypeId: secondEventTypeId })).creatorUserId,
    ).toBe(admin.id)
  })

  async function memberCapacity(module: LinkModule) {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const other = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
      { user: other, role: 'member' },
    ])
    const ctx = testContext(db, session(team.as(member)), NOW)
    const eventTypeId = await fixtures.eventType(team.id, member.id)
    const secondEvent = await fixtures.eventType(team.id, member.id)
    const s = { user: member, ctx, eventTypeId, organizationId: team.id }
    await fillCapacity(s, Links.ONE_TIME_BOOKING_LINK_MEMBER_LIMIT - 1)
    const attempts = await Promise.allSettled([
      module.createOneTimeBookingLink(ctx, { eventTypeId }),
      module.createOneTimeBookingLink(ctx, { eventTypeId: secondEvent }),
    ])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const failed = attempts.find((result) => result.status === 'rejected')
    expect(
      failed?.status === 'rejected' &&
        failed.reason?.name === 'DomainError' &&
        failed.reason.code === 'one_time_link_limit_reached',
    ).toBe(true)
    expect(
      await failure(() => module.createOneTimeBookingLink(ctx, { eventTypeId: secondEvent })),
    ).toMatchObject({ code: 'one_time_link_limit_reached' })
    const anotherEvent = await fixtures.eventType(team.id, other.id)
    expect(
      (
        await module.createOneTimeBookingLink(testContext(db, session(team.as(other)), NOW), {
          eventTypeId: anotherEvent,
        })
      ).state,
    ).toBe('active')
    const retained = await db
      .selectFrom('one_time_booking_links')
      .select('id')
      .where('event_type_id', '=', eventTypeId)
      .executeTakeFirstOrThrow()
    await module.revokeOneTimeBookingLink(ctx, retained.id)
    expect((await module.createOneTimeBookingLink(ctx, { eventTypeId: secondEvent })).state).toBe(
      'active',
    )
    // Current persisted roles decide the sub-limit, including a stale member principal.
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', member.id)
      .execute()
    expect((await module.createOneTimeBookingLink(ctx, { eventTypeId })).state).toBe('active')
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', member.id)
      .execute()
    expect(
      await failure(() => module.createOneTimeBookingLink(ctx, { eventTypeId })),
    ).toMatchObject({ code: 'one_time_link_limit_reached' })
    const teamEvent = await fixtures.eventType(team.id, null)
    for (const user of [owner, admin]) {
      await fillCapacity(
        { user, ctx, eventTypeId: teamEvent, organizationId: team.id },
        Links.ONE_TIME_BOOKING_LINK_MEMBER_LIMIT,
      )
      expect(
        (
          await module.createOneTimeBookingLink(testContext(db, session(team.as(user)), NOW), {
            eventTypeId: teamEvent,
          })
        ).state,
      ).toBe('active')
    }
  }

  it('limits ordinary team members to 200 active links across their events while preserving owner/admin capacity', async () => {
    await memberCapacity(Links)
  })

  async function verifyCapacityLock(module: LinkModule) {
    const s = await setup()
    const counted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const observed = db.withPlugin({
      transformQuery: ({ node }) => node,
      transformResult: async ({ result }) => {
        if (result.rows.some((row) => 'creatorCount' in row)) {
          counted.resolve()
          await release.promise
        }
        return result
      },
    })
    const writer = module.createOneTimeBookingLink(
      { ...s.ctx, db: observed },
      { eventTypeId: s.eventTypeId },
    )
    try {
      await counted.promise
      const { available } = await db.transaction().execute(async (trx) => {
        await sql`set local lock_timeout = '500ms'`.execute(trx)
        const lock = await sql<{
          available: boolean
        }>`select pg_try_advisory_xact_lock(hashtextextended(${`hourmere.one-time-links:${s.organizationId}`}, 0)) as available`.execute(
          trx,
        )
        // A normal organization FK insert must continue while link capacity is locked.
        const inserted = await insertBooking(trx, s).then(
          () => true,
          () => false,
        )
        expect(inserted).toBe(true)
        return lock.rows[0] as { available: boolean }
      })
      expect(available).toBe(false)
    } finally {
      release.resolve()
      await writer
    }
  }

  it('serializes capacity with a scoped advisory lock while allowing organization FK inserts', async () => {
    await verifyCapacityLock(Links)
  })

  async function writeAlongsidePublicOwnerLock(module: LinkModule) {
    const s = await setup()
    const hookHoldsOrganization = Promise.withResolvers<void>()
    const readerHoldsOwner = Promise.withResolvers<void>()
    const ctx = {
      ...s.ctx,
      authorizeOrganizationWrite: async (trx: Db) => {
        await sql`set local lock_timeout = '1s'`.execute(trx)
        // A browser organization-write hook already takes these locks in this order.
        await trx
          .selectFrom('auth.user')
          .select('id')
          .where('id', '=', s.user.id)
          .forShare()
          .executeTakeFirstOrThrow()
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', s.organizationId)
          .forUpdate()
          .executeTakeFirstOrThrow()
        hookHoldsOrganization.resolve()
        // Resume the service only once another transaction holds the same user SHARE.
        await readerHoldsOwner.promise
      },
    }
    const writer = module
      .createOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId })
      .finally(() => {
        // If setup fails, let the other transaction finish rather than leaving a waiter.
        hookHoldsOrganization.resolve()
        readerHoldsOwner.resolve()
      })
    const publicReader = (async () => {
      await hookHoldsOrganization.promise
      return db.transaction().execute(async (trx) => {
        await sql`set local lock_timeout = '4s'`.execute(trx)
        // Public booking takes owner SHARE before organization SHARE. The latter waits
        // for the writer, while the writer must never upgrade the shared owner lock.
        await trx
          .selectFrom('auth.user')
          .select('id')
          .where('id', '=', s.user.id)
          .forShare()
          .executeTakeFirstOrThrow()
        readerHoldsOwner.resolve()
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', s.organizationId)
          .forShare()
          .executeTakeFirstOrThrow()
      })
    })().finally(() => readerHoldsOwner.resolve())
    const outcomes = await Promise.allSettled([writer, publicReader])
    // Boolean assertions never include the newly generated capability in diagnostics.
    expect(outcomes[0]?.status === 'fulfilled').toBe(true)
    expect(outcomes[1]?.status === 'fulfilled').toBe(true)
  }

  it('finishes an organization-authorized write while a public booking holds the same owner SHARE lock', async () => {
    await writeAlongsidePublicOwnerLock(Links)
  })

  it('does not charge expired or used retained rows against available link capacity', async () => {
    const s = await setup()
    const used = await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
    await bookAndClaim(s, used.token)
    await sql`insert into one_time_booking_links (organization_id, event_type_id, creator_user_id, token_hash, expires_at)
      select ${s.organizationId}::uuid, ${s.eventTypeId}::uuid, ${s.user.id}::uuid,
      encode(sha256(('synthetic-expired-' || ${randomUUID()} || n::text)::bytea), 'hex'), clock_timestamp() - interval '1 day'
      from generate_series(1, ${Links.ONE_TIME_BOOKING_LINK_LIMIT}) n`.execute(db)
    expect(
      (await Links.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })).state,
    ).toBe('active')
    expect(
      await db
        .selectFrom('one_time_booking_links')
        .select('id')
        .where('organization_id', '=', s.organizationId)
        .execute(),
    ).toHaveLength(Links.ONE_TIME_BOOKING_LINK_LIMIT + 2)
  })

  type Check = (module: LinkModule) => Promise<void>
  async function mutation(replacement: readonly [string, string], verify: Check) {
    await verify(await sourceCopy())
    const copy = await sourceCopy(replacement)
    await expect(verify(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  }

  it('detects weakened token entropy with a real assertion failure', async () => {
    await mutation(
      ["randomBytes(32).toString('base64url')", "randomBytes(16).toString('base64url')"],
      async (module) => {
        const s = await setup()
        const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
        expect(/^[A-Za-z0-9_-]{43}$/.test(link.token)).toBe(true)
      },
    )
  })

  it('detects substituted token hashing with a real assertion failure', async () => {
    await mutation(
      [
        "return createHash('sha256').update(token).digest('hex')",
        "return createHash('sha256').update('fixed synthetic token digest').digest('hex')",
      ],
      async (module) => {
        const s = await setup()
        const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
        const stored = await db
          .selectFrom('one_time_booking_links')
          .select('token_hash')
          .where('id', '=', link.id)
          .executeTakeFirstOrThrow()
        expect(stored.token_hash === createHash('sha256').update(link.token).digest('hex')).toBe(
          true,
        )
      },
    )
  })

  it.each([
    ['return {\n    id: live.id,', 'return {\n    tokenHash: live.token_hash,\n    id: live.id,'],
    ['return {\n    id: row.id,', 'return {\n    tokenHash: row.token_hash,\n    id: row.id,'],
  ] as const)(
    'detects leaking credential digests from a metadata projection %#',
    async (from, to) => {
      await mutation([from, to], async (module) => {
        const s = await setup()
        const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
        const hash = createHash('sha256').update(link.token).digest('hex')
        expect(JSON.stringify(link).includes(hash)).toBe(false)
        noCapability(await module.resolveOneTimeBookingLink({ db }, link.token), link.token, hash)
        noCapability(await module.revokeOneTimeBookingLink(s.ctx, link.id), link.token, hash)
      })
    },
  )

  it('detects bypassing the stored-digest comparison result with a real assertion failure', async () => {
    await mutation(
      ['return valid && matches ? row : undefined', 'return valid ? row : undefined'],
      async (module) => {
        const s = await setup()
        const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
        // Query real Postgres, then simulate a mismatched stored digest returned by its adapter.
        const mismatched = db.withPlugin({
          transformQuery: ({ node }) => node,
          transformResult: async ({ result }) => ({
            ...result,
            rows: result.rows.map((row) =>
              'token_hash' in row ? { ...row, token_hash: '0'.repeat(64) } : row,
            ),
          }),
        })
        expect(
          await failure(() => module.resolveOneTimeBookingLink({ db: mismatched }, link.token)),
        ).toMatchObject({ code: 'one_time_link_not_found' })
      },
    )
  })

  it('detects removed terminal-state resolution filtering with a real assertion failure', async () => {
    await mutation(
      [".where('id', '=', id)\n    .where('state', '=', 'active')", ".where('id', '=', id)"],
      async (module) => {
        const s = await setup()
        const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
        await module.revokeOneTimeBookingLink(s.ctx, link.id)
        expect(
          await failure(() => module.resolveOneTimeBookingLink({ db }, link.token)),
        ).toMatchObject({ code: 'one_time_link_not_found' })
      },
    )
  })

  it('detects removed resolution expiry filtering with a real assertion failure', async () => {
    await mutation(
      [
        ".where('id', '=', id)\n    .where('state', '=', 'active')\n    .where((eb) =>\n      eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`clock_timestamp()`)]),\n    )",
        ".where('id', '=', id)\n    .where('state', '=', 'active')",
      ],
      async (module) => {
        const s = await setup()
        const token = randomBytes(32).toString('base64url')
        await db
          .insertInto('one_time_booking_links')
          .values({
            organization_id: s.organizationId,
            event_type_id: s.eventTypeId,
            creator_user_id: s.user.id,
            token_hash: createHash('sha256').update(token).digest('hex'),
            expires_at: sql`clock_timestamp() - interval '1 second'`,
          })
          .execute()
        expect(await failure(() => module.resolveOneTimeBookingLink({ db }, token))).toMatchObject({
          code: 'one_time_link_not_found',
        })
      },
    )
  })

  it('detects removed creation expiry validation with a real assertion failure', async () => {
    await mutation(
      ['if (!future) throw invalid()', 'if (false) throw invalid()'],
      async (module) => {
        const s = await setup()
        expect(
          await failure(() =>
            module.createOneTimeBookingLink(s.ctx, {
              eventTypeId: s.eventTypeId,
              expiresAt: '2000-01-01T00:00:00Z',
            }),
          ),
        ).toMatchObject({ code: 'invalid_one_time_link' })
      },
    )
  })

  it('detects inactive-event issuance with a real assertion failure', async () => {
    await mutation(
      ['if (!event.is_active || event.deleted_at !== null)', 'if (false)'],
      async (module) => {
        const s = await setup()
        await db
          .updateTable('event_types')
          .set({ is_active: false })
          .where('id', '=', s.eventTypeId)
          .execute()
        expect(
          await failure(() =>
            module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId }),
          ),
        ).toMatchObject({ code: 'event_type_inactive' })
      },
    )
  })

  it('detects inactive-event resolution with a real assertion failure', async () => {
    await mutation(
      [
        'if (!event?.is_active || event.deleted_at !== null) return false',
        'if (!event) return false',
      ],
      async (module) => {
        const s = await setup()
        const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
        await db
          .updateTable('event_types')
          .set({ is_active: false })
          .where('id', '=', s.eventTypeId)
          .execute()
        expect(
          await failure(() => module.resolveOneTimeBookingLink({ db }, link.token)),
        ).toMatchObject({ code: 'one_time_link_not_found' })
      },
    )
  })

  it('detects departed-owner resolution with a real assertion failure', async () => {
    await mutation(
      [
        'if (!(await memberQuery.executeTakeFirst())) return false',
        'await memberQuery.executeTakeFirst()',
      ],
      async (module) => {
        const s = await setup()
        const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', s.organizationId)
          .where('userId', '=', s.user.id)
          .execute()
        expect(
          await failure(() => module.resolveOneTimeBookingLink({ db }, link.token)),
        ).toMatchObject({ code: 'one_time_link_not_found' })
      },
    )
  })

  it('detects unverified-owner resolution with a real assertion failure', async () => {
    await mutation(
      [
        'if (!(await ownerQuery.executeTakeFirst())?.emailVerified) return false',
        'await ownerQuery.executeTakeFirst()',
      ],
      async (module) => {
        const s = await setup()
        const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', s.user.id)
          .execute()
        expect(
          await failure(() => module.resolveOneTimeBookingLink({ db }, link.token)),
        ).toMatchObject({ code: 'one_time_link_not_found' })
      },
    )
  })

  it('detects removed current actor verification with a real assertion failure', async () => {
    await mutation(
      [
        'if (!actor?.emailVerified) throw insufficientRole()',
        'if (!actor) throw insufficientRole()',
      ],
      async (module) => {
        const s = await setup()
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', s.user.id)
          .execute()
        expect(
          await failure(() =>
            module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId }),
          ),
        ).toMatchObject({ code: 'insufficient_role' })
      },
    )
  })

  it('detects removed team role authorization with a real assertion failure', async () => {
    await mutation(
      [
        "if (event.owner_user_id === null && !roles.includes('owner') && !roles.includes('admin'))",
        'if (false)',
      ],
      async (module) => {
        const owner = await createTestUser(db)
        const member = await createTestUser(db)
        const team = await createTestTeam(db, [
          { user: owner, role: 'owner' },
          { user: member, role: 'member' },
        ])
        const eventTypeId = await fixtures.eventType(team.id, null)
        const ctx = testContext(db, session(team.as(member)), NOW)
        expect(
          await failure(() => module.createOneTimeBookingLink(ctx, { eventTypeId })),
        ).toMatchObject({ code: 'insufficient_role' })
      },
    )
  })

  it('detects removed personal-event ownership with a real assertion failure', async () => {
    await mutation(
      [
        'if (!event || (event.owner_user_id !== null && event.owner_user_id !== ctx.principal.user.id))',
        'if (!event)',
      ],
      async (module) => {
        const owner = await createTestUser(db)
        const member = await createTestUser(db)
        const team = await createTestTeam(db, [
          { user: owner, role: 'owner' },
          { user: member, role: 'member' },
        ])
        const eventTypeId = await fixtures.eventType(team.id, owner.id)
        const ctx = testContext(db, session(team.as(member)), NOW)
        expect(
          await failure(() => module.createOneTimeBookingLink(ctx, { eventTypeId })),
        ).toMatchObject({ code: 'event_type_not_found' })
      },
    )
  })

  it('detects weakened API-key configuration scope with a real assertion failure', async () => {
    await mutation(
      [
        "if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope !== 'full')",
        'if (false)',
      ],
      async (module) => {
        const s = await setup()
        const { ctx } = await apiKey(s, 'bookings')
        await expect(
          module.createOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId }),
        ).rejects.toMatchObject({ name: 'ApiKeyScopeError', error: 'insufficient_scope' })
      },
    )
  })

  it('detects removed persisted-key revalidation with a real assertion failure', async () => {
    await mutation(
      [
        "if (ctx.principal.kind === 'api_key') await requireActiveApiKey(trx, ctx.principal, Date.now)",
        '',
      ],
      async (module) => {
        const s = await setup()
        const { ctx, keyId } = await apiKey(s, 'full')
        await db
          .updateTable('auth.apikey')
          .set({ enabled: false })
          .where('id', '=', keyId)
          .execute()
        await expect(
          module.createOneTimeBookingLink(ctx, { eventTypeId: s.eventTypeId }),
        ).rejects.toMatchObject({ name: 'InvalidApiKeyError' })
      },
    )
  })

  it('detects removed owner capacity limits with a real assertion failure', async () => {
    await mutation(
      ['if (Number(count) >= ONE_TIME_BOOKING_LINK_LIMIT)', 'if (false)'],
      async (module) => {
        const s = await setup()
        await fillCapacity(s, Links.ONE_TIME_BOOKING_LINK_LIMIT)
        expect(
          await failure(() =>
            module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId }),
          ),
        ).toMatchObject({ code: 'one_time_link_limit_reached' })
      },
    )
  })

  it('detects removed revoke effect with a real assertion failure', async () => {
    await mutation(
      [
        ".set({ state: 'revoked', revoked_at: sql<Date>`clock_timestamp()` })",
        '.set({ updated_at: sql<Date>`clock_timestamp()` })',
      ],
      async (module) => {
        const s = await setup()
        const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
        await module.revokeOneTimeBookingLink(s.ctx, link.id)
        expect((await storedLink(link.id)).state).toBe('revoked')
      },
    )
  })

  it('detects a claim outside the booking transaction with a real assertion failure', async () => {
    await mutation(
      ["if (!trx.isTransaction) throw new TypeError('A booking transaction is required')", ''],
      async (module) => {
        const s = await setup()
        const link = await module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId })
        await expect(
          module.claimOneTimeBookingLink(db as Transaction<Database>, link.token, await booking(s)),
        ).rejects.toBeInstanceOf(TypeError)
      },
    )
  })

  it('detects removed member sub-limits with a real assertion failure', async () => {
    await mutation(
      [
        'if (event.memberLimited && Number(creatorCount) >= ONE_TIME_BOOKING_LINK_MEMBER_LIMIT)',
        'if (false)',
      ],
      memberCapacity,
    )
  })

  it('detects removed capacity advisory locking with a real assertion failure', async () => {
    await mutation(
      [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation
        'await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hourmere.one-time-links:${ctx.principal.organization.id}`}, 0))`.execute(\n      trx,\n    )',
        '',
      ],
      verifyCapacityLock,
    )
  })

  it('detects heavy organization-row locking with a real assertion failure', async () => {
    await mutation(
      [
        ".where('id', '=', ctx.principal.organization.id)\n    .forShare()",
        ".where('id', '=', ctx.principal.organization.id)\n    .forUpdate()",
      ],
      verifyCapacityLock,
    )
  })

  it('detects an existence-dependent revoke failure with a real assertion failure', async () => {
    await mutation(
      [
        'const personal = await lockWriteOwner(trx, ctx)',
        "const personal = await lockWriteOwner(trx, ctx)\n    if (!(await trx.selectFrom('one_time_booking_links').select('id').where('id', '=', candidateId).executeTakeFirst())) throw linkNotFound()",
      ],
      verifyUniformRevoke,
    )
  })

  it('detects removed same-transaction booking validation before a claim write', async () => {
    await mutation(['.where(sql<boolean>`xmin = pg_current_xact_id()::xid`)', ''], (module) =>
      verifyNewBooking(module, false, true),
    )
  })

  it('detects reusing an existing booking updated in the claiming transaction', async () => {
    await mutation(
      [".where('created_at', '=', sql<Date>`transaction_timestamp()`)", ''],
      (module) => verifyNewBooking(module, true),
    )
  })

  it('detects accepting another transaction booking with a later creation timestamp', async () => {
    await mutation(
      [
        ".where('created_at', '=', sql<Date>`transaction_timestamp()`)",
        ".where('created_at', '>=', sql<Date>`transaction_timestamp()`)",
      ],
      verifyOverlappingBooking,
    )
  })

  it('detects removed prefill email validation with a real assertion failure', async () => {
    await mutation(['(email !== null && !EMAIL.test(email))', 'false'], async (module) => {
      const s = await setup()
      expect(
        await failure(() =>
          module.createOneTimeBookingLink(s.ctx, {
            eventTypeId: s.eventTypeId,
            prefill: { email: 'not-an-email' },
          }),
        ),
      ).toMatchObject({ code: 'invalid_one_time_link' })
    })
  })

  it('detects removed prefill normalization with a real assertion failure', async () => {
    await mutation(
      ['return { name, email: email?.toLowerCase() ?? null }', 'return { name, email }'],
      async (module) => {
        const s = await setup()
        const link = await module.createOneTimeBookingLink(s.ctx, {
          eventTypeId: s.eventTypeId,
          prefill: { name: '  Grace  ', email: 'GRACE@example.com' },
        })
        expect(link.prefill).toEqual({ name: 'Grace', email: 'grace@example.com' })
      },
    )
  })

  it('detects removed single-line prefill validation with a real assertion failure', async () => {
    await mutation(['cleanText(input.name, { max: 200 })', 'input.name'], async (module) => {
      const s = await setup()
      expect(
        await failure(() =>
          module.createOneTimeBookingLink(s.ctx, {
            eventTypeId: s.eventTypeId,
            prefill: { name: 'Grace\nHopper' },
          }),
        ),
      ).toMatchObject({ code: 'invalid_one_time_link' })
    })
  })

  it('detects removed prefill field whitelist with a real assertion failure', async () => {
    await mutation(
      [
        "if (Object.keys(value).some((key) => key !== 'name' && key !== 'email')) throw invalid()",
        '',
      ],
      async (module) => {
        const s = await setup()
        const prefill = { name: 'Grace', unexpected: 'unsupported' }
        expect(
          await failure(() =>
            module.createOneTimeBookingLink(s.ctx, { eventTypeId: s.eventTypeId, prefill }),
          ),
        ).toMatchObject({ code: 'invalid_one_time_link' })
      },
    )
  })

  it('detects an owner-lock upgrade deadlock with a real assertion failure', async () => {
    await mutation(
      [
        ".where('id', '=', ctx.principal.user.id)\n    .forShare()",
        ".where('id', '=', ctx.principal.user.id)\n    .forUpdate()",
      ],
      writeAlongsidePublicOwnerLock,
    )
  })
})
