import { createHash, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { SelectQueryNode, TableNode } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BookingNotifier } from './context.ts'
import { type CreateBookingSeriesInput, createPublicBookingSeries } from './recurring-creation.ts'
import { expandRecurringRule, type RecurringRule } from './recurring-rules.ts'
import { createFixtures, type EventTypeFixture } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const actorDigest = Buffer.alloc(32, 1)
const enabled = { actorDigest, recurringBookingsEnabled: true }
const recurrence = { allowedPatterns: ['weekly'], maxOccurrences: 3, timeZone: 'UTC' }
const rule = { pattern: 'weekly', count: 2 } satisfies RecurringRule
const invitee = { name: 'Invitee', email: 'invitee@example.test', timeZone: 'UTC' }

describe.skipIf(!serverUrl)('recurring creation receipts and admission on PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'series_receipts' })
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(eventOptions: EventTypeFixture = {}, sharedOrganizationId?: string) {
    const f = createFixtures(db)
    const host = await f.host({ timeZone: 'UTC' })
    const organizationId = sharedOrganizationId ?? host.organizationId
    if (sharedOrganizationId) await f.member(host.userId, organizationId)
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const slug = 'recurring'
    const eventTypeId = await f.eventType(organizationId, host.userId, {
      ...eventOptions,
      slug,
    })
    const { recurrence_revision: eventRevision } = await db
      .updateTable('event_types')
      .set({ recurrence: JSON.stringify(recurrence), recurrence_revision: 1 })
      .where('id', '=', eventTypeId)
      .returning('recurrence_revision')
      .executeTakeFirstOrThrow()

    function request(hour = '09'): CreateBookingSeriesInput {
      const firstLocalStart = `2026-11-02T${hour}:00:00+00:00`
      const occurrences = expandRecurringRule({
        rule,
        firstLocalStart,
        timeZone: recurrence.timeZone,
        durationMinutes: 30,
        now: now(),
      })
      return {
        handle: host.handle,
        slug,
        rule,
        firstLocalStart,
        invitee,
        idempotencyKey: randomUUID(),
        expectedPreview: {
          eventRevision,
          rule,
          durationMinutes: 30,
          timeZone: recurrence.timeZone,
          occurrences: occurrences.map(({ ordinal, localStart, start, end, offset }) => ({
            ordinal,
            localStart,
            start: start?.toString() ?? null,
            end: end?.toString() ?? null,
            offset,
          })),
        },
      }
    }

    function admissions() {
      return db
        .selectFrom('booking_series_admissions')
        .select('actor_digest')
        .where('event_type_id', '=', eventTypeId)
        .execute()
    }

    return { ...host, organizationId, request, admissions, eventTypeId, ctx: { db, now } }
  }

  async function whileHostLocked<T>(
    userId: string,
    waiterCount: number,
    submit: () => Promise<T>,
  ): Promise<T> {
    const holding = await owned.pool.connect()
    let pending: Promise<T> | undefined
    try {
      await holding.query('BEGIN')
      await holding.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `booking-host:${userId}`,
      ])
      pending = submit()
      pending.catch(() => {})
      await vi.waitFor(
        async () => {
          const { rows } = await owned.pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          )
          expect(rows[0]?.count).toBe(waiterCount)
        },
        { timeout: 5_000 },
      )
    } finally {
      try {
        await holding.query('ROLLBACK')
      } finally {
        holding.release()
        await pending?.catch(() => {})
      }
    }
    return pending
  }

  it('keeps admission hard-off without the code-only override', async () => {
    const s = await setup()
    await expect(
      createPublicBookingSeries(s.ctx, s.request(), { actorDigest }),
    ).rejects.toMatchObject({ code: 'recurrence_not_supported' })
    expect(await s.admissions()).toEqual([])
  })

  it('rejects invalid input and changed expansion without counting them', async () => {
    const s = await setup({
      questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: true }],
    })
    const input = s.request()
    await expect(createPublicBookingSeries(s.ctx, input, enabled)).rejects.toMatchObject({
      code: 'invalid_responses',
    })
    const valid = { ...input, responses: { topic: 'Planning' } }
    await expect(
      createPublicBookingSeries(s.ctx, { ...valid, idempotencyKey: 'invalid key' }, enabled),
    ).rejects.toMatchObject({ code: 'invalid_idempotency_key' })
    await expect(
      createPublicBookingSeries(
        s.ctx,
        { ...valid, rule: { pattern: 'weekly', count: 13 } },
        enabled,
      ),
    ).rejects.toMatchObject({ code: 'invalid_recurrence' })
    const expectedPreview = {
      ...valid.expectedPreview,
      occurrences: valid.expectedPreview.occurrences.map((occurrence, index) =>
        index === 1 ? { ...occurrence, end: '2026-11-09T09:45:00Z' } : occurrence,
      ),
    }
    await expect(
      createPublicBookingSeries(s.ctx, { ...valid, expectedPreview }, enabled),
    ).rejects.toMatchObject({ code: 'series_changed' })
    await db
      .updateTable('event_types')
      .set({ recurrence_revision: 2 })
      .where('id', '=', s.eventTypeId)
      .execute()
    await expect(createPublicBookingSeries(s.ctx, valid, enabled)).rejects.toMatchObject({
      code: 'series_changed',
    })
    expect(await s.admissions()).toEqual([])
    expect(
      await db
        .selectFrom('booking_series')
        .select('id')
        .where('event_type_id', '=', s.eventTypeId)
        .execute(),
    ).toEqual([])
  })

  it.each([
    ['google_meet', 'automatic_meet'],
    ['zoom', 'automatic_zoom'],
  ])('preserves automatic %s eligibility before admission commits', async (kind, code) => {
    const s = await setup({ location: { kind, autoCreate: true } })
    const request = s.request()
    await expect(createPublicBookingSeries(s.ctx, request, enabled)).rejects.toMatchObject({
      code: `${code}_disabled`,
    })
    await expect(
      createPublicBookingSeries(
        { ...s.ctx, automaticMeet: true, automaticZoom: true },
        request,
        enabled,
      ),
    ).rejects.toMatchObject({ code: `${code}_unavailable` })
    expect(await s.admissions()).toEqual([])
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', s.eventTypeId)
        .execute(),
    ).toEqual([])
  })

  it('separates receipt authority from the actor cap and replays current state at the cap', async () => {
    const s = await setup()
    const input = s.request()
    const created = await createPublicBookingSeries(s.ctx, input, enabled)
    expect(created.replayed).toBe(false)
    expect(created.occurrences.map(({ ordinal }) => ordinal)).toEqual([1, 2])
    expect(/^[A-Za-z0-9_-]{43}$/.test(created.manageToken ?? '')).toBe(true)
    const series = await db
      .selectFrom('booking_series')
      .select('manage_token_hash')
      .where('id', '=', created.seriesId)
      .executeTakeFirstOrThrow()
    expect(series.manage_token_hash).toEqual(
      createHash('sha256')
        .update(created.manageToken as string)
        .digest(),
    )

    const receipt = await db
      .selectFrom('booking_series_receipts')
      .selectAll()
      .where('series_id', '=', created.seriesId)
      .executeTakeFirstOrThrow()
    expect(receipt).toMatchObject({
      operation_kind: 'create',
      idempotency_key: createHash('sha256').update(input.idempotencyKey).digest(),
      affected_occurrence_ids: created.occurrences.map(({ id }) => id),
      result_booking_ids: created.occurrences.map(({ bookingId }) => bookingId),
    })
    expect(receipt.authority_scope).toHaveLength(32)
    expect(receipt.fingerprint).toHaveLength(32)

    // A fresh key makes a new submission, and cannot recover an existing series.
    await expect(createPublicBookingSeries(s.ctx, s.request(), enabled)).rejects.toMatchObject({
      code: 'series_unavailable',
    })
    const apiKey = { source: 'api', apiKeyId: randomUUID() } as const
    const oauth = { source: 'mcp', apiKeyId: null, oauthConsentId: randomUUID() } as const
    for (const origin of [apiKey, oauth]) {
      await expect(
        createPublicBookingSeries(s.ctx, input, { ...enabled, origin }),
      ).rejects.toMatchObject({ code: 'series_unavailable' })
    }
    expect(await s.admissions()).toEqual([{ actor_digest: actorDigest }])

    await createPublicBookingSeries(s.ctx, s.request('10'), enabled)
    await expect(createPublicBookingSeries(s.ctx, s.request('11'), enabled)).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: expect.any(Number),
    })
    await expect(
      createPublicBookingSeries(
        s.ctx,
        { ...input, invitee: { ...invitee, name: 'Name changed' } },
        enabled,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    const first = created.occurrences[0]
    if (!first) throw new Error('Expected the first occurrence')
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: now().toString() })
      .where('id', '=', first.bookingId)
      .execute()
    await db
      .updateTable('event_types')
      .set({
        recurrence: null,
        recurrence_revision: 2,
        questions: JSON.stringify([
          { id: 'new', label: 'New question', type: 'short_text', required: true },
        ]),
      })
      .where('id', '=', s.eventTypeId)
      .execute()
    const expectedPreview = {
      ...input.expectedPreview,
      checkedAt: '2026-11-01T00:01:00Z',
      canBook: false,
      seriesReason: 'no_common_host',
      occurrences: input.expectedPreview.occurrences.map((occurrence) => ({
        ...occurrence,
        available: false,
        reason: 'unavailable',
        label: 'A display-only label',
      })),
    }
    const retry = { ...input, invitee: { ...invitee, name: ' Invitee ' }, expectedPreview }
    const replay = await createPublicBookingSeries(s.ctx, retry, enabled)
    expect(replay.manageToken === null).toBe(true)
    expect(replay.seriesId).toBe(created.seriesId)
    expect(replay.replayed).toBe(true)
    expect(replay.occurrences).toEqual(
      created.occurrences.map((occurrence) =>
        occurrence.ordinal === 1 ? { ...occurrence, status: 'cancelled' } : occurrence,
      ),
    )
    // Anonymous receipt scope is shared, even when the address used for admission changes.
    await expect(
      createPublicBookingSeries(s.ctx, retry, { actorDigest: Buffer.alloc(32, 2) }),
    ).resolves.toEqual(replay)
    expect(await s.admissions()).toEqual([
      { actor_digest: actorDigest },
      { actor_digest: actorDigest },
    ])
    await db
      .updateTable('event_types')
      .set({ is_active: false })
      .where('id', '=', s.eventTypeId)
      .execute()
    await expect(createPublicBookingSeries(s.ctx, input, enabled)).rejects.toMatchObject({
      code: 'event_type_not_found',
    })
  })

  it.each([true, false])(
    'returns one creation and one receipt for the same concurrent key (same address: %s)',
    async (sameAddress) => {
      const s = await setup()
      const input = s.request()
      const retryOptions = {
        ...enabled,
        actorDigest: sameAddress ? actorDigest : Buffer.alloc(32, 2),
      }
      const attempts = await whileHostLocked(s.userId, 2, () =>
        Promise.allSettled([
          createPublicBookingSeries(s.ctx, input, enabled),
          createPublicBookingSeries(s.ctx, input, retryOptions),
        ]),
      )
      expect(attempts.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled'])
      const results = attempts
        .filter((attempt) => attempt.status === 'fulfilled')
        .map(({ value }) => value)
      expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true])
      expect(results[0]?.seriesId).toBe(results[1]?.seriesId)
      expect(results[0]?.occurrences).toEqual(results[1]?.occurrences)
      expect(results.find(({ replayed }) => replayed)?.manageToken === null).toBe(true)
      expect(await s.admissions()).toHaveLength(1)
    },
  )

  it('replays a receipt committed just before the optimistic check encounters a new revision', async () => {
    const s = await setup()
    const request = s.request()
    const readReceipt = Promise.withResolvers<void>()
    const resumeRetry = Promise.withResolvers<void>()
    let intercepted = false
    const retryDb = db.withPlugin({
      transformQuery({ node }) {
        if (
          !intercepted &&
          SelectQueryNode.is(node) &&
          node.from?.froms.some(
            (from) =>
              TableNode.is(from) && from.table.identifier.name === 'booking_series_receipts',
          )
        ) {
          intercepted = true
        }
        return node
      },
      async transformResult({ result }) {
        if (intercepted) {
          readReceipt.resolve()
          await resumeRetry.promise
        }
        return result
      },
    })
    const retry = createPublicBookingSeries({ ...s.ctx, db: retryDb }, request, enabled)
    retry.catch(readReceipt.reject)
    try {
      await readReceipt.promise
      const winner = await createPublicBookingSeries(s.ctx, request, enabled)
      await db
        .updateTable('event_types')
        .set({ recurrence_revision: 2 })
        .where('id', '=', s.eventTypeId)
        .execute()
      resumeRetry.resolve()
      const replay = await retry
      expect(replay.replayed).toBe(true)
      expect(replay.seriesId).toBe(winner.seriesId)
      expect(replay.manageToken === null).toBe(true)
      expect(await s.admissions()).toHaveLength(1)
    } finally {
      resumeRetry.resolve()
      await retry.catch(() => {})
    }
  })

  it('rolls back the losing receipt insert when one key races across two host pools', async () => {
    const first = await setup()
    const second = await setup({}, first.organizationId)
    const firstRequest = first.request()
    const secondRequest = { ...second.request(), idempotencyKey: firstRequest.idempotencyKey }
    const release = Promise.withResolvers<void>()
    const notifyWebhook = vi.fn<BookingNotifier>(async () => release.promise)
    const options = { ...enabled, notifyWebhook }
    const pending = Promise.allSettled([
      createPublicBookingSeries(first.ctx, firstRequest, options),
      createPublicBookingSeries(second.ctx, secondRequest, options),
    ])
    try {
      // Both transactions inserted a booking before either can write a receipt.
      await vi.waitFor(() => expect(notifyWebhook).toHaveBeenCalledTimes(2))
    } finally {
      release.resolve()
      await pending
    }
    const results = await pending
    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({
      code: 'idempotency_key_reused',
    })
    expect([...(await first.admissions()), ...(await second.admissions())]).toHaveLength(1)
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', 'in', [first.eventTypeId, second.eventTypeId])
        .execute(),
    ).toHaveLength(2)
  })

  it('serializes the rolling admission counter for different concurrent keys', async () => {
    const s = await setup()
    await createPublicBookingSeries(s.ctx, s.request(), enabled)
    const results = await whileHostLocked(s.userId, 2, () =>
      Promise.allSettled([
        createPublicBookingSeries(s.ctx, s.request('10'), enabled),
        createPublicBookingSeries(s.ctx, s.request('11'), enabled),
      ]),
    )
    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: expect.any(Number),
    })
    expect(await s.admissions()).toHaveLength(2)

    // Another actor gets its own allowance for this event.
    const unusedHour = results[0]?.status === 'fulfilled' ? '11' : '10'
    await expect(
      createPublicBookingSeries(s.ctx, s.request(unusedHour), {
        ...enabled,
        actorDigest: Buffer.alloc(32, 2),
      }),
    ).resolves.toMatchObject({ replayed: false })
    expect(await s.admissions()).toHaveLength(3)
  })
})
