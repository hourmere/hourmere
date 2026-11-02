import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Database, Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Availability from './availability.ts'
import * as Bookings from './bookings.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import * as Links from './one-time-links.ts'
import { createFixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const now = () => instant('2026-11-01T00:00Z')
const invitee = { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' }

/** Exercise isolated source copies without rewriting the production files. */
async function sourceCopy<T>(name: string, replacement?: readonly [string, string]): Promise<T> {
  const location = new URL(name, import.meta.url)
  const original = readFileSync(location, 'utf8')
  if (replacement)
    expect(original.includes(replacement[0]), 'mutation must match source').toBe(true)
  const source = stripTypeScriptTypes(
    replacement ? original.replace(...replacement) : original,
  ).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

describe.skipIf(!serverUrl)('one-time unavailable query work', () => {
  let owned: TestDatabase
  let db: Db
  let ctx: PublicContext
  let statements: string[] = []
  const tokens: string[] = []
  const winnerKey = randomUUID()

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'one_time_timing' })
    // One shared pool, closed by owned.drop(). Capture statement shapes only, never parameters.
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log: (event) => {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
    ctx = { db, now }
    const f = createFixtures(db)
    tokens.push('malformed', randomBytes(32).toString('base64url'))
    for (const state of [
      'inactive',
      'deleted',
      'unverified',
      'departed',
      'expired',
      'revoked',
      'used',
    ]) {
      const host = await f.host({ timeZone: 'UTC' })
      await f.schedule(host.userId, { timeZone: 'UTC' })
      const eventTypeId = await f.eventType(host.organizationId, host.userId)
      const service: ServiceContext = {
        ...ctx,
        principal: {
          kind: 'session',
          sessionId: randomUUID(),
          user: { id: host.userId, name: 'Host', email: 'host@example.com' },
          organization: { id: host.organizationId, slug: '', name: '', personal: true },
        },
      }
      if (state === 'expired') {
        const token = randomBytes(32).toString('base64url')
        await db
          .insertInto('one_time_booking_links')
          .values({
            organization_id: host.organizationId,
            event_type_id: eventTypeId,
            creator_user_id: host.userId,
            token_hash: createHash('sha256').update(token).digest('hex'),
            expires_at: sql`clock_timestamp() - interval '1 second'`,
          })
          .execute()
        tokens.push(token)
        continue
      }
      const link = await Links.createOneTimeBookingLink(service, { eventTypeId })
      tokens.push(link.token)
      if (state === 'inactive' || state === 'deleted')
        await db
          .updateTable('event_types')
          .set(state === 'inactive' ? { is_active: false } : { deleted_at: new Date() })
          .where('id', '=', eventTypeId)
          .execute()
      if (state === 'unverified')
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', host.userId)
          .execute()
      if (state === 'departed')
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', host.organizationId)
          .where('userId', '=', host.userId)
          .execute()
      if (state === 'revoked') await Links.revokeOneTimeBookingLink(service, link.id)
      if (state === 'used')
        await Bookings.createOneTimeBooking(ctx, {
          token: link.token,
          start: instant('2026-11-02T09:00Z'),
          invitee,
          idempotencyKey: winnerKey,
        })
    }
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function unavailableQueries(work: () => Promise<unknown>) {
    statements = []
    const outcome = await work().then(
      () => null,
      (error: unknown) => error,
    )
    expect(outcome).toMatchObject({
      name: 'DomainError',
      kind: 'not_found',
      code: 'one_time_link_not_found',
    })
    return [...statements]
  }

  async function sameWork(work: (token: string) => Promise<unknown>, count: number) {
    let expected: string[] | undefined
    for (const token of tokens) {
      const queries = await unavailableQueries(() => work(token))
      expect(queries).toHaveLength(count)
      if (expected) expect(queries).toEqual(expected)
      expected ??= queries
    }
  }

  it('uses one identical joined lookup for unavailable page and slot requests', async () => {
    await sameWork((token) => Availability.getOneTimeBookingPage(ctx, token), 1)
    await sameWork(
      (token) =>
        Availability.listOneTimeBookingSlots(ctx, {
          token,
          start: instant('2026-11-02T09:00Z'),
          end: instant('2026-11-02T10:00Z'),
        }),
      1,
    )
    expect(owned.pool.totalCount).toBeLessThan(10)
  })

  function bookingInput(
    token: string,
    idempotencyKey?: string,
  ): Bookings.CreateOneTimeBookingInput {
    return {
      token,
      start: instant('2026-11-02T09:00Z'),
      // Even the winning key must be neutral for a different request.
      invitee: { ...invitee, name: 'Different request' },
      idempotencyKey,
    }
  }

  it.each(['fresh', 'winning', 'missing', 'invalid'] as const)(
    'runs identical replay probes for every unavailable state with a %s key',
    async (kind) => {
      const key =
        kind === 'fresh'
          ? randomUUID()
          : kind === 'winning'
            ? winnerKey
            : kind === 'invalid'
              ? '\n'
              : undefined
      await sameWork((token) => Bookings.createOneTimeBooking(ctx, bookingInput(token, key)), 5)
    },
  )

  it('detects state-dependent resolution queries in an isolated source copy', async () => {
    const baseline = await sourceCopy<typeof Links>('./one-time-links.ts')
    const verify = (module: typeof Links) =>
      sameWork((token) => module.resolveOneTimeBookingLink(ctx, token), 1)
    await verify(baseline)
    const mutant = await sourceCopy<typeof Links>('./one-time-links.ts', [
      'const live = await lookupToken(ctx.db, token, true)',
      'const initial = await lookupToken(ctx.db, token)\n  if (!initial) throw linkNotFound()\n  const live = await lookupToken(ctx.db, token, true)',
    ])
    await expect(verify(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
    await verify(baseline)
  })

  it('detects a skipped non-used replay probe in an isolated source copy', async () => {
    const baseline = await sourceCopy<typeof Bookings>('./bookings.ts')
    const verify = (module: typeof Bookings) =>
      sameWork((token) => module.createOneTimeBooking(ctx, bookingInput(token, winnerKey)), 5)
    await verify(baseline)
    const mutant = await sourceCopy<typeof Bookings>('./bookings.ts', [
      'const used = await oneTimeBookingReplayTarget(ctx, input.token)',
      'const used = await oneTimeBookingReplayTarget(ctx, input.token)\n  if (!used) return undefined',
    ])
    await expect(verify(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
    await verify(baseline)
  })
})
