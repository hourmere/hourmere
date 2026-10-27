import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import * as bookings from '@hourmere/scheduling'
import { createTestTeam, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { teamManagementAccess } from './team-management.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
type BookingModule = Pick<
  typeof bookings,
  'cancelHostBooking' | 'cancelManagedBooking' | 'cancelTeamBookingInTransaction'
>

// Execute a changed copy, leaving the working source and parallel test processes intact.
async function sourceCopy(before: string, after: string): Promise<BookingModule> {
  const location = new URL('../../../packages/scheduling/src/bookings.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  expect(source.includes(before), 'mutation matches real source').toBe(true)
  source = stripTypeScriptTypes(source.replace(before, after)).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

describe.skipIf(!serverUrl)('booking operation attribution', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture() {
    const manager = await createTestUser(db, 'Manager')
    const host = await createTestUser(db, 'Original host')
    const outsider = await createTestUser(db, 'Other team')
    const team = await createTestTeam(db, [
      { user: manager, role: 'admin' },
      { user: host, role: 'owner' },
    ])
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: manager.id,
        token: `synthetic-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const principal: Principal = {
      ...team.as(manager),
      kind: 'session',
      sessionId: session.id,
    }
    const keyId = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const booking = await db
      .insertInto('bookings')
      .values({
        organization_id: team.id,
        start_at: '2026-11-02T09:00Z',
        end_at: '2026-11-02T09:30Z',
        title: 'Synthetic meeting',
        source: 'api',
        api_key_id: keyId,
        required_host_user_ids: [host.id],
        responses: JSON.stringify({ private: 'private-answer-marker' }),
        manage_token_hash: createHash('sha256').update(token).digest(),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_hosts')
      .values({ booking_id: booking.id, user_id: host.id })
      .execute()
    const access = teamManagementAccess(db, async (_c, next) => next())
    return { manager, host, outsider, team, principal, booking, token, access, keyId }
  }

  const operations = (id: string) =>
    db.selectFrom('organization_operations').selectAll().where('booking_id', '=', id).execute()

  async function verifyTeam(copy: BookingModule) {
    const s = await fixture()
    await s.access.write(s.principal, s.team.id, (trx, actor) =>
      copy.cancelTeamBookingInTransaction(trx, actor, s.booking.id, now, {
        reason: 'private-reason-marker',
      }),
    )
    const rows = await operations(s.booking.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      organization_id: s.team.id,
      operation: 'booking_cancelled',
      actor_user_id: s.manager.id,
      booking_id: s.booking.id,
      target_user_id: null,
      previous_role: null,
      new_role: null,
      source: 'web',
      api_key_id: null,
      oauth_consent_id: null,
      occurred_at: new Date(now().toString()),
    })
    const serialized = JSON.stringify(rows)
    for (const marker of [s.token, 'private-answer-marker', 'private-reason-marker', s.host.email])
      expect(serialized.includes(marker)).toBe(false)
    const stored = await db
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', s.booking.id)
      .executeTakeFirstOrThrow()
    expect(stored.source).toBe('api')
    expect(stored.api_key_id).toBe(s.keyId)
    expect(stored.created_at).toEqual(s.booking.created_at)
    expect(stored.start_at).toEqual(s.booking.start_at)
    expect(stored.end_at).toEqual(s.booking.end_at)
    expect(stored.required_host_user_ids).toEqual([s.host.id])
    expect(stored.responses).toEqual(s.booking.responses)
    expect(stored.cancelled_source).toBe('web')
    expect(stored.cancelled_at).toEqual(new Date(now().toString()))
    await expect(
      s.access.write(s.principal, s.team.id, (trx, actor) =>
        copy.cancelTeamBookingInTransaction(trx, actor, s.booking.id, now),
      ),
    ).rejects.toMatchObject({ code: 'booking_cancelled' })
    expect(await operations(s.booking.id)).toHaveLength(1)
  }

  it('records a non-host administrator, preserving the original booking and excluding private data', async () => {
    await verifyTeam(bookings)
  })

  it('keeps team scope, existing cancellation time rules and transactional notification failure', async () => {
    const s = await fixture()
    const cancel = (id: string, instant = now(), notify?: bookings.BookingNotifier) =>
      s.access.write(s.principal, s.team.id, (trx, actor) =>
        bookings.cancelTeamBookingInTransaction(trx, actor, id, () => instant, { notify }),
      )
    await expect(cancel(randomUUID())).rejects.toMatchObject({ code: 'booking_not_found' })
    const outside = await db
      .insertInto('bookings')
      .values({
        organization_id: s.outsider.principal.organization.id,
        title: 'Other organization',
        source: 'web',
        start_at: '2026-11-02T09:00Z',
        end_at: '2026-11-02T09:30Z',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await expect(cancel(outside.id)).rejects.toMatchObject({ code: 'booking_not_found' })
    await expect(
      cancel(s.booking.id, Temporal.Instant.from('2026-11-02T09:00Z')),
    ).rejects.toMatchObject({ code: 'booking_in_past' })
    await expect(
      cancel(s.booking.id, now(), async () => {
        throw new Error('synthetic queue failure')
      }),
    ).rejects.toThrow('synthetic queue failure')
    expect(await operations(s.booking.id)).toEqual([])
    const row = await db
      .selectFrom('bookings')
      .select(['status', 'cancelled_at'])
      .where('id', '=', s.booking.id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ status: 'confirmed', cancelled_at: null })
  })

  it('serializes two cancellations and rolls the booking back when recording fails', async () => {
    const s = await fixture()
    const cancelled = () =>
      bookings.cancelHostBooking(testContext(db, s.team.as(s.host), now), s.booking.id)
    // A conflicting synthetic record makes the real INSERT fail after the status update.
    await db
      .insertInto('organization_operations')
      .values({
        organization_id: s.team.id,
        operation: 'booking_cancelled',
        booking_id: s.booking.id,
        source: 'web',
        actor_user_id: s.manager.id,
      })
      .execute()
    await expect(cancelled()).rejects.toMatchObject({ code: '23505' })
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('status')
          .where('id', '=', s.booking.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('confirmed')
    await db.deleteFrom('organization_operations').where('booking_id', '=', s.booking.id).execute()
    const results = await Promise.allSettled([cancelled(), cancelled()])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await operations(s.booking.id)).toHaveLength(1)
  })

  it.each(['session', 'api_key', 'oauth'] as const)(
    'records the actual %s host with its existing origin',
    async (kind) => {
      const s = await fixture()
      const base = s.team.as(s.host)
      const credential = randomUUID()
      const principal: Principal =
        kind === 'session'
          ? { ...base, kind, sessionId: randomUUID() }
          : kind === 'api_key'
            ? { ...base, kind, apiKeyId: credential }
            : {
                ...base,
                kind,
                oauthConsentId: credential,
                clientId: 'https://synthetic.test',
                scopes: [],
              }
      await bookings.cancelHostBooking(testContext(db, principal, now), s.booking.id)
      expect((await operations(s.booking.id))[0]).toMatchObject({
        actor_user_id: s.host.id,
        source: kind === 'session' ? 'web' : kind === 'oauth' ? 'mcp' : 'api',
        api_key_id: kind === 'api_key' ? credential : null,
        oauth_consent_id: kind === 'oauth' ? credential : null,
      })
    },
  )

  it('leaves anonymous link identity unknown and records an authenticated link caller independently of the host', async () => {
    for (const authenticated of [false, true]) {
      const s = await fixture()
      await bookings.cancelManagedBooking(
        { db, now },
        s.token,
        {},
        authenticated
          ? {
              source: 'mcp',
              apiKeyId: null,
              oauthConsentId: randomUUID(),
              actorUserId: s.outsider.id,
            }
          : undefined,
      )
      expect((await operations(s.booking.id))[0]?.actor_user_id).toBe(
        authenticated ? s.outsider.id : null,
      )
    }
  })

  it('runs the original source copy against the real attribution assertions', async () => {
    await verifyTeam(await sourceCopy('    actor.userId,\n', '    actor.userId,\n'))
  })

  it('detects a removed team actor assignment in a source copy', async () => {
    const copy = await sourceCopy('    actor.userId,\n', '    null,\n')
    await expect(verifyTeam(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects an omitted operation write in a source copy', async () => {
    const copy = await sourceCopy(
      "  await db\n    .insertInto('organization_operations')",
      "  if (false) await db\n    .insertInto('organization_operations')",
    )
    await expect(verifyTeam(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects lost host and private-link actor propagation in source copies', async () => {
    const s = await fixture()
    const hostCopy = await sourceCopy('      ctx.principal.user.id,\n', '      null,\n')
    await hostCopy.cancelHostBooking(testContext(db, s.team.as(s.host), now), s.booking.id)
    const verifyHost = async () =>
      expect((await operations(s.booking.id))[0]?.actor_user_id).toBe(s.host.id)
    await expect(verifyHost()).rejects.toMatchObject({ name: 'AssertionError' })
    const link = await fixture()
    const linkCopy = await sourceCopy('      origin.actorUserId ?? null,\n', '      null,\n')
    await linkCopy.cancelManagedBooking(
      { db, now },
      link.token,
      {},
      {
        source: 'mcp',
        apiKeyId: randomUUID(),
        actorUserId: link.outsider.id,
      },
    )
    const verifyLink = async () =>
      expect((await operations(link.booking.id))[0]?.actor_user_id).toBe(link.outsider.id)
    await expect(verifyLink()).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('requires the team helper transaction and detects removal of that guard', async () => {
    const verify = async (copy: BookingModule) => {
      const s = await fixture()
      await expect(
        copy.cancelTeamBookingInTransaction(
          db as Parameters<BookingModule['cancelTeamBookingInTransaction']>[0],
          { userId: s.manager.id, organizationId: s.team.id },
          s.booking.id,
          now,
        ),
      ).rejects.toThrow('Team cancellation requires a transaction')
    }
    await verify(bookings)
    const copy = await sourceCopy(
      "  if (!trx.isTransaction) throw new Error('Team cancellation requires a transaction')\n",
      '',
    )
    await expect(verify(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects lost team scoping in a source copy', async () => {
    const copy = await sourceCopy("    .where('organization_id', '=', actor.organizationId)\n", '')
    const s = await fixture()
    const outside = await db
      .insertInto('bookings')
      .values({
        organization_id: s.outsider.principal.organization.id,
        title: 'Other organization',
        source: 'web',
        start_at: '2026-11-02T09:00Z',
        end_at: '2026-11-02T09:30Z',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const assertion = async () => {
      await expect(
        s.access.write(s.principal, s.team.id, (trx, actor) =>
          copy.cancelTeamBookingInTransaction(trx, actor, outside.id, now),
        ),
      ).rejects.toMatchObject({ code: 'booking_not_found' })
    }
    await expect(assertion()).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function verifyClockAfterLock(copy: BookingModule) {
    const s = await fixture()
    let release = () => {}
    let acquired = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const locked = new Promise<void>((resolve) => {
      acquired = resolve
    })
    const blocker = db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('bookings')
        .select('id')
        .where('id', '=', s.booking.id)
        .forUpdate()
        .execute()
      acquired()
      await hold
    })
    await locked
    let instant = now()
    const outcome = s.access
      .write(s.principal, s.team.id, (trx, actor) =>
        copy.cancelTeamBookingInTransaction(trx, actor, s.booking.id, () => instant),
      )
      .then(
        () => null,
        (error: unknown) => error,
      )
    try {
      await expect
        .poll(
          async () =>
            (
              await owned.pool.query<{ waiting: boolean }>(`
        SELECT EXISTS (SELECT FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND wait_event_type='Lock' AND query LIKE '%bookings%') AS waiting
      `)
            ).rows[0]?.waiting,
          { timeout: 3000, interval: 10 },
        )
        .toBe(true)
      instant = Temporal.Instant.from('2026-11-02T09:00Z')
    } finally {
      release()
      await blocker
    }
    await expect(outcome).resolves.toMatchObject({ code: 'booking_in_past' })
    expect(await operations(s.booking.id)).toEqual([])
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('status')
          .where('id', '=', s.booking.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('confirmed')
  }

  it('rechecks the cancellation window after waiting for the booking lock', async () => {
    await verifyClockAfterLock(bookings)
  })

  it('detects a clock read moved before the booking lock in a source copy', async () => {
    const copy = await sourceCopy(
      "  if (!trx.isTransaction) throw new Error('Team cancellation requires a transaction')",
      "  const checkedAt = now(); now = () => checkedAt;\n  if (!trx.isTransaction) throw new Error('Team cancellation requires a transaction')",
    )
    await expect(verifyClockAfterLock(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function verifyCancellationLockOrder(copy: BookingModule, path: 'host' | 'manage') {
    const s = await fixture()
    let release = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let paused = false
    const updates = new WeakSet<object>()
    const observed = db.withPlugin({
      transformQuery({ node, queryId }) {
        if (
          node.kind === 'UpdateQueryNode' &&
          JSON.stringify(node).includes('"name":"bookings"') &&
          JSON.stringify(node).includes('"value":"cancelled"')
        )
          updates.add(queryId)
        return node
      },
      async transformResult({ result, queryId }) {
        if (updates.has(queryId) && !paused) {
          paused = true
          // The UPDATE is complete, while its transaction still holds the booking.
          // The next operation INSERT must acquire its organization foreign-key lock.
          await hold
        }
        return result
      },
    })
    const settle = <T>(operation: Promise<T>): Promise<PromiseSettledResult<T>> =>
      operation.then(
        (value) => ({ status: 'fulfilled', value }),
        (reason: unknown) => ({ status: 'rejected', reason }),
      )
    const cancellation = settle(
      path === 'host'
        ? copy.cancelHostBooking(testContext(observed, s.team.as(s.host), now), s.booking.id)
        : copy.cancelManagedBooking({ db: observed, now }, s.token),
    )
    let teamCancellation: Promise<PromiseSettledResult<void>> | undefined
    try {
      await expect.poll(() => paused, { timeout: 3000, interval: 10 }).toBe(true)
      teamCancellation = settle(
        s.access.write(s.principal, s.team.id, (trx, actor) =>
          copy.cancelTeamBookingInTransaction(trx, actor, s.booking.id, now),
        ),
      )
      let waiting: { query: string }[] = []
      await expect
        .poll(
          async () => {
            waiting = (
              await owned.pool.query<{ query: string }>(`SELECT query FROM pg_stat_activity
                WHERE datname=current_database() AND pid<>pg_backend_pid()
                  AND wait_event_type='Lock' AND query LIKE '%for update%'`)
            ).rows
            return waiting.length
          },
          { timeout: 3000, interval: 10 },
        )
        .toBe(1)
      // Both paths must already hold the parent before locking/updating the booking.
      // Without that order, team management owns the parent and waits for the booking,
      // forming a cycle when cancellation INSERTs its organization operation record.
      expect(waiting[0]?.query).toContain('from "auth"."organization"')
    } finally {
      release()
      await Promise.all([cancellation, teamCancellation])
    }
    const outcomes = await Promise.all([cancellation, teamCancellation])
    expect(outcomes[0]).toMatchObject({ status: 'fulfilled', value: { status: 'cancelled' } })
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { code: 'booking_cancelled' } })
    for (const result of outcomes)
      if (result?.status === 'rejected')
        expect((result.reason as { code?: string }).code).not.toBe('40P01')
    const rows = await operations(s.booking.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actor_user_id).toBe(path === 'host' ? s.host.id : null)
  }

  it.each(['host', 'manage'] as const)(
    'locks the organization before the booking for a %s cancellation racing team management',
    async (path) => {
      await verifyCancellationLockOrder(bookings, path)
    },
    10_000,
  )

  it.each(['host', 'manage'] as const)(
    'detects a missing parent lock in a %s cancellation source copy',
    async (path) => {
      const copy = await sourceCopy(
        path === 'host'
          ? '    await lockCancellationOrganization(trx, ctx.principal.organization.id)\n'
          : '    await lockCancellationOrganization(trx, parent.organization_id)\n',
        '',
      )
      await expect(verifyCancellationLockOrder(copy, path)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
    10_000,
  )

  async function verifyDeletedOrganization(copy: BookingModule) {
    const s = await fixture()
    const principal = s.team.as(s.host)
    await db.deleteFrom('auth.organization').where('id', '=', s.team.id).execute()
    await expect(
      copy.cancelHostBooking(testContext(db, principal, now), s.booking.id),
    ).rejects.toMatchObject({ code: 'booking_not_found' })
  }

  it('keeps the booking error when the organization disappears after authentication', async () => {
    await verifyDeletedOrganization(bookings)
  })

  it('detects a changed missing-parent cancellation error in a source copy', async () => {
    const copy = await sourceCopy(
      '    .forKeyShare()\n    .executeTakeFirst()\n  if (!row) throw bookingNotFound()',
      "    .forKeyShare()\n    .executeTakeFirst()\n  if (!row) throw new DomainError('not_found', 'event_type_not_found')",
    )
    await expect(verifyDeletedOrganization(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
