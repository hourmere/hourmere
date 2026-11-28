import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import {
  cancelManagedBooking,
  createPublicTeamBooking,
  getManagedBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import type { BookingNotifier } from './context.ts'
import { applyDepartureHandoff } from './departure-handoff-apply.ts'
import {
  createHandoffTestFixture,
  HANDOFF_END,
  HANDOFF_NOW,
  HANDOFF_START,
  handoffTestRecords,
  handoffTestSession,
} from './departure-handoff-apply-test-fixture.ts'
import { createFixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const movedStart = HANDOFF_START.add({ hours: 1 })
const denied = { kind: 'forbidden', code: 'team_management_access_denied' }
const changed = { kind: 'conflict', code: 'handoff_offer_changed' }
const ineligible = { kind: 'conflict', code: 'handoff_source_ineligible' }
type Fixture = Awaited<ReturnType<typeof createHandoffTestFixture>>

describe.skipIf(!serverUrl)('internal departure handoff apply', () => {
  let owned: TestDatabase
  let db: Db
  let storage: Awaited<ReturnType<typeof handoffTestRecords>>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'handoff_apply' })
    owned.pool.options.max = 6
    db = createDb(owned.pool)
    storage = handoffTestRecords(db)
    await sql`CREATE TABLE test_handoff_lifecycle (
      booking_id uuid NOT NULL REFERENCES bookings,
      event_type text NOT NULL,
      PRIMARY KEY (booking_id, event_type)
    )`.execute(db)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  const notify: BookingNotifier = async (trx, event) => {
    expect(trx.isTransaction).toBe(true)
    await sql`INSERT INTO test_handoff_lifecycle (booking_id, event_type)
      VALUES (${event.bookingId}, ${event.type})`.execute(trx)
  }

  async function setup() {
    return createHandoffTestFixture(db, { applyContext: { notify } })
  }

  async function approve(f: Fixture) {
    return storage.offer(f.ctx, f.input, { departingUserId: f.departing.id })
  }

  async function closeOffer(f: Fixture) {
    await db
      .updateTable('departure_handoff_offers')
      .set({ state: 'closed' })
      .where('organization_id', '=', f.team.id)
      .where('source_booking_id', '=', f.booking.id)
      .where('id', '=', f.input.offerId)
      .where('version', '=', f.input.version)
      .execute()
  }

  const apply = (f: Fixture) => applyDepartureHandoff(f.ctx, f.input, storage.store)

  const bookings = (f: Fixture) =>
    db
      .selectFrom('bookings')
      .select([
        'id',
        'status',
        'rescheduled_from_id',
        'required_host_user_ids',
        'manage_token_hash',
        'responses',
        'start_at',
        'end_at',
        'sms_reminders_enabled',
      ])
      .where('organization_id', '=', f.team.id)
      .execute()

  const hosts = (f: Fixture) =>
    db
      .selectFrom('booking_hosts as host')
      .innerJoin('bookings as booking', 'booking.id', 'host.booking_id')
      .select(['host.booking_id', 'host.user_id', 'host.active'])
      .where('booking.organization_id', '=', f.team.id)
      .execute()

  const attendees = (bookingId: string) =>
    db
      .selectFrom('booking_attendees')
      .select(['name', 'email', 'time_zone', 'locale', 'is_booker', 'sms_consent', 'sms_phone'])
      .where('booking_id', '=', bookingId)
      .orderBy('is_booker', 'desc')
      .execute()

  async function intents(f: Fixture) {
    const { rows } = await sql<{ booking_id: string; event_type: string }>`
      SELECT lifecycle.booking_id, lifecycle.event_type FROM test_handoff_lifecycle AS lifecycle
      JOIN bookings AS booking ON booking.id = lifecycle.booking_id
      WHERE booking.organization_id = ${f.team.id} ORDER BY lifecycle.event_type`.execute(db)
    return rows
  }

  async function expectUnchanged(f: Fixture, original?: Awaited<ReturnType<typeof bookings>>) {
    const current = await bookings(f)
    expect(current).toEqual([
      expect.objectContaining({
        id: f.booking.id,
        status: 'confirmed',
        rescheduled_from_id: null,
        required_host_user_ids: [f.departing.id],
      }),
    ])
    if (original) expect(current).toEqual(original)
    expect(await hosts(f)).toEqual([
      { booking_id: f.booking.id, user_id: f.departing.id, active: true },
    ])
    expect(await storage.receipts(f.input)).toEqual([])
    expect(await intents(f)).toEqual([])
  }

  it('cancels the source without moving its identity and commits one fresh independent chain', async () => {
    const f = await setup()
    await db
      .updateTable('booking_attendees')
      .set({ sms_phone: '+12025550123', sms_consent: true })
      .where('booking_id', '=', f.booking.id)
      .where('is_booker', '=', true)
      .execute()
    const originalAttendees = await attendees(f.booking.id)
    const [originalBooking] = await bookings(f)
    const { offer } = await approve(f)

    const result = await apply(f)
    const replacementId = result.replacementBookingId
    expect(result).toEqual({ sourceBookingId: f.booking.id, replacementBookingId: replacementId })
    expect(replacementId).not.toBe(f.booking.id)
    const allBookings = await bookings(f)
    expect(allBookings).toHaveLength(2)
    const source = allBookings.find((booking) => booking.id === f.booking.id)
    const replacement = allBookings.find((booking) => booking.id === replacementId)
    expect(source).toEqual({ ...originalBooking, status: 'cancelled' })
    expect(replacement).toEqual({
      id: replacementId,
      status: 'confirmed',
      rescheduled_from_id: null,
      required_host_user_ids: [f.candidate.id],
      manage_token_hash: expect.any(Buffer),
      responses: { notes: 'Approved answer' },
      start_at: new Date(HANDOFF_START.epochMilliseconds),
      end_at: new Date(HANDOFF_END.epochMilliseconds),
      sms_reminders_enabled: false,
    })
    expect(replacement?.manage_token_hash).not.toEqual(source?.manage_token_hash)
    expect(await hosts(f)).toHaveLength(2)
    expect(await hosts(f)).toEqual(
      expect.arrayContaining([
        { booking_id: f.booking.id, user_id: f.departing.id, active: false },
        { booking_id: replacementId, user_id: f.candidate.id, active: true },
      ]),
    )
    expect(await attendees(f.booking.id)).toEqual(originalAttendees)
    expect(await attendees(replacementId)).toEqual(
      originalAttendees.map((attendee) => ({ ...attendee, sms_consent: false, sms_phone: null })),
    )
    expect(await getManagedBooking(f.ctx, f.manageToken)).toMatchObject({
      id: f.booking.id,
      status: 'cancelled',
    })
    expect(await storage.receipts(f.input)).toEqual([
      {
        version: f.input.version,
        applyingUserId: f.owner.id,
        appliedAt: HANDOFF_NOW.toString(),
        recipientIds: offer.approvals.map((approval) => approval.recipientId),
        replacementBookingId: replacementId,
      },
    ])
    expect(
      await storage.store.readLatest(db, {
        organizationId: f.team.id,
        sourceBookingId: f.booking.id,
      }),
    ).toMatchObject({
      state: 'closed',
      committed: { replacementBookingId: replacementId },
    })
    expect(await intents(f)).toEqual([
      { booking_id: f.booking.id, event_type: 'cancelled' },
      { booking_id: replacementId, event_type: 'created' },
    ])

    expect(await apply(f)).toEqual(result)
    expect(await bookings(f)).toEqual(allBookings)
    await expect(
      applyDepartureHandoff(f.ctx, { ...f.input, version: 2 }, storage.store),
    ).rejects.toMatchObject(changed)
  })

  it('rechecks live team authority before returning a committed receipt', async () => {
    const f = await setup()
    await approve(f)
    await apply(f)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.owner.id)
      .execute()
    await expect(apply(f)).rejects.toMatchObject(denied)
  })

  it('rolls back if the administrator session expires before commit', async () => {
    const f = await setup()
    await approve(f)
    const { sessionId } = f.ctx.principal
    const { expiresAt } = await db
      .updateTable('auth.session')
      .set({ expiresAt: sql<Date>`clock_timestamp() + interval '2 seconds'` })
      .where('id', '=', sessionId)
      .returning('expiresAt')
      .executeTakeFirstOrThrow()
    let wroteReceipt = false
    await expect(
      applyDepartureHandoff(f.ctx, f.input, {
        ...storage.store,
        async commitHandoff(trx, key, evidence) {
          await storage.store.commitHandoff(trx, key, evidence)
          wroteReceipt = true
          await sql`SELECT pg_sleep_until(${expiresAt}::timestamptz + interval '1 millisecond')`.execute(
            trx,
          )
        },
      }),
    ).rejects.toMatchObject(denied)
    expect(wroteReceipt).toBe(true)
    await expectUnchanged(f)
  })

  it('keeps ordinary members and mismatched team contexts outside the write path', async () => {
    const f = await setup()
    await approve(f)
    const principal = await handoffTestSession(db, f.candidate, f.ctx.principal.organization)
    await expect(
      applyDepartureHandoff({ ...f.ctx, principal }, f.input, storage.store),
    ).rejects.toMatchObject(denied)
    await expect(
      applyDepartureHandoff(f.ctx, { ...f.input, expectedOrganizationId: '' }, storage.store),
    ).rejects.toMatchObject({ kind: 'conflict', code: 'organization_context_changed' })
    await expect(
      applyDepartureHandoff(f.ctx, { ...f.input, bookingId: randomUUID() }, storage.store),
    ).rejects.toMatchObject({ kind: 'not_found', code: 'booking_not_found' })
    await expect(
      applyDepartureHandoff(f.ctx, { ...f.input, offerId: randomUUID() }, storage.store),
    ).rejects.toMatchObject({ kind: 'not_found', code: 'handoff_offer_not_found' })
    await expectUnchanged(f)
  })

  it('requires the distinct guest to approve the same live offer as the booker', async () => {
    const f = await setup()
    const { recipientKeys } = await storage.offer(
      f.ctx,
      f.input,
      { departingUserId: f.departing.id },
      (offer) => ({ ...offer, approvals: offer.approvals.slice(0, 1) }),
    )
    expect(recipientKeys).toHaveLength(2)
    await expect(apply(f)).rejects.toMatchObject({
      kind: 'conflict',
      code: 'handoff_consent_required',
    })
    await expectUnchanged(f)
  })

  it('refuses approval from the previous offer version even when the terms are unchanged', async () => {
    const f = await setup()
    const original = await bookings(f)
    const first = await approve(f)
    await closeOffer(f)

    const revised = { ...f, input: { ...f.input, version: f.input.version + 1 } }
    const next = await storage.offer(
      revised.ctx,
      revised.input,
      { departingUserId: f.departing.id },
      (offer) => ({ ...offer, approvals: [] }),
    )
    expect(next.offer.termsDigest).toBe(first.offer.termsDigest)
    expect(
      await storage.store.readLatest(db, {
        organizationId: f.team.id,
        sourceBookingId: f.booking.id,
      }),
    ).toMatchObject({ id: f.input.offerId, version: revised.input.version, approvals: [] })

    await expect(apply(f)).rejects.toMatchObject(changed)
    await expect(apply(revised)).rejects.toMatchObject({
      kind: 'conflict',
      code: 'handoff_consent_required',
    })
    await expectUnchanged(f, original)
  })

  it('scopes offer lookups to the team and source even if an offer ID is known', async () => {
    const f = await setup()
    await approve(f)
    const wrongTeam = {
      organizationId: randomUUID(),
      sourceBookingId: f.booking.id,
      offerId: f.input.offerId,
      version: f.input.version,
    }
    const wrongSource = {
      ...wrongTeam,
      organizationId: f.team.id,
      sourceBookingId: randomUUID(),
    }
    for (const key of [wrongTeam, wrongSource]) {
      await expect(storage.store.readLatest(db, key)).resolves.toBeUndefined()
      await expect(
        db.transaction().execute((trx) => storage.store.lockOffer(trx, key)),
      ).resolves.toBeUndefined()
    }
  })

  it('reads offer terms, decision times and deadlines at stored microsecond precision', async () => {
    const f = await setup()
    const start = HANDOFF_START.add({ microseconds: 123 }).toString()
    const issuedAt = HANDOFF_NOW.subtract({ hours: 1, microseconds: 456 }).toString()
    const expiresAt = HANDOFF_START.subtract({ microseconds: 789 }).toString()
    const approvedAt = HANDOFF_NOW.subtract({ minutes: 30, microseconds: 123 }).toString()
    await storage.offer(f.ctx, f.input, { departingUserId: f.departing.id, start }, (offer) => ({
      ...offer,
      issuedAt,
      expiresAt,
      approvals: offer.approvals.map((approval) => ({ ...approval, approvedAt })),
    }))
    const key = {
      organizationId: f.team.id,
      sourceBookingId: f.booking.id,
      offerId: f.input.offerId,
      version: f.input.version,
    }
    const saved = await db.transaction().execute((trx) => storage.store.lockOffer(trx, key))
    expect(saved).toMatchObject({
      start,
      issuedAt,
      expiresAt,
      approvals: [{ approvedAt }, { approvedAt }],
    })
  })

  it('refuses expired offers and changes to terms since approval', async () => {
    const f = await setup()
    await storage.offer(f.ctx, f.input, { departingUserId: f.departing.id }, (offer) => ({
      ...offer,
      expiresAt: HANDOFF_NOW.toString(),
    }))
    await expect(apply(f)).rejects.toMatchObject(changed)
    await closeOffer(f)
    const newOffer = { ...f, input: { ...f.input, offerId: randomUUID(), version: 2 } }
    await approve(newOffer)
    await db
      .updateTable('bookings')
      .set({ responses: JSON.stringify({ notes: 'Different answer' }) })
      .where('id', '=', f.booking.id)
      .execute()
    await expect(apply(newOffer)).rejects.toMatchObject(changed)
    await expectUnchanged(f)
  })

  it('rolls back both booking states, the receipt and the first intent when the second intent fails', async () => {
    const f = await setup()
    const original = await bookings(f)
    await approve(f)
    const failure = new Error('test notifier could not queue creation')
    await expect(
      applyDepartureHandoff(
        {
          ...f.ctx,
          async notify(trx, event, now) {
            await notify(trx, event, now)
            if (event.type === 'created') throw failure
          },
        },
        f.input,
        storage.store,
      ),
    ).rejects.toBe(failure)
    await expectUnchanged(f, original)
    await expect(apply(f)).resolves.toMatchObject({ sourceBookingId: f.booking.id })
  })

  it('rechecks replacement occupancy after approval and rolls any transition back', async () => {
    const f = await setup()
    await approve(f)
    const competing = await createPublicTeamBooking(
      { db, now: f.ctx.now },
      {
        handle: f.ctx.principal.organization.slug,
        slug: 'handoff',
        start: HANDOFF_START,
        invitee: { name: 'Other Booker', email: 'other@example.test', timeZone: 'UTC' },
      },
    )
    const original = await bookings(f)
    expect(original).toHaveLength(2)
    await expect(apply(f)).rejects.toMatchObject({ kind: 'conflict', code: 'slot_unavailable' })
    expect(await bookings(f)).toEqual(original)
    expect(await storage.receipts(f.input)).toEqual([])
    expect(await intents(f)).toEqual([])
    expect(await hosts(f)).toEqual(
      expect.arrayContaining([
        { booking_id: f.booking.id, user_id: f.departing.id, active: true },
        { booking_id: competing.booking.id, user_id: f.candidate.id, active: true },
      ]),
    )
  })

  it('requires fresh calendars and excludes only a copy mapped to the source', async () => {
    const f = await setup()
    await approve(f)
    const original = await bookings(f)
    const { calendarId, externalEventIds } = await createFixtures(db).calendarBusy(
      f.candidate.id,
      [[HANDOFF_START.toString(), HANDOFF_END.toString()]],
      { now: HANDOFF_NOW.subtract({ minutes: 11 }) },
    )
    const [externalEventId] = externalEventIds
    if (!externalEventId) throw new Error('Missing calendar fixture')
    await expect(apply(f)).rejects.toMatchObject({ code: 'calendar_sync_unavailable' })
    await expectUnchanged(f, original)
    await db
      .updateTable('calendars')
      .set({ last_synced_at: new Date(HANDOFF_NOW.epochMilliseconds) })
      .where('id', '=', calendarId)
      .execute()
    await expect(apply(f)).rejects.toMatchObject({ code: 'slot_unavailable' })
    await expectUnchanged(f, original)
    await db
      .insertInto('booking_calendar_events')
      .values({
        booking_id: f.booking.id,
        calendar_id: calendarId,
        external_event_id: externalEventId,
      })
      .execute()
    await expect(apply(f)).resolves.toMatchObject({ sourceBookingId: f.booking.id })
  })

  // Hold the source row briefly to make winner and loser order deterministic. Probe
  // actual lock waits, using Vitest's existing deadline rather than a timing assumption.
  async function waitForLock(blockerPid: number, relation: string, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted()
      const { rows } = await owned.pool.query<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype = 'tuple' AND relation = $2::regclass
           AND $1 = ANY(pg_blocking_pids(pid))`,
        [blockerPid, relation],
      )
      if (rows[0]) return rows[0].pid
      await setTimeout(10, undefined, { signal })
    }
  }

  async function race<A, B>(
    f: Fixture,
    first: () => Promise<A>,
    second: () => Promise<B>,
    { signal, onTestFinished }: TestContext,
  ) {
    const completed = Promise.withResolvers<void>()
    onTestFinished(() => completed.promise)
    const holder = await owned.pool.connect().catch((error: unknown) => {
      completed.resolve()
      throw error
    })
    let requests: Promise<unknown>[] = []
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM bookings WHERE id = $1 FOR UPDATE', [f.booking.id])
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const holderPid = rows[0]?.pid
      if (holderPid === undefined) throw new Error('Missing lock holder backend')
      const winner = Promise.allSettled([first()])
      requests = [winner]
      const winnerPid = await waitForLock(holderPid, 'bookings', signal)
      // The pending writer must leave room for other team booking writers.
      await holder.query('SELECT id FROM auth.organization WHERE id = $1 FOR SHARE NOWAIT', [
        f.team.id,
      ])
      const loser = Promise.allSettled([second()])
      requests.push(loser)
      await waitForLock(winnerPid, 'bookings', signal)
      await expectUnchanged(f)
      await holder.query('COMMIT')
      const [[firstResult], [secondResult]] = await Promise.all([winner, loser])
      return { firstResult, secondResult }
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      await Promise.allSettled(requests)
      completed.resolve()
    }
  }

  it('serializes concurrent applies and replays the same receipt', async (testContext) => {
    const f = await setup()
    await approve(f)
    const { firstResult, secondResult } = await race(
      f,
      () => apply(f),
      () => apply(f),
      testContext,
    )
    expect(firstResult).toMatchObject({ status: 'fulfilled' })
    expect(secondResult).toEqual(firstResult)
    expect(await bookings(f)).toHaveLength(2)
    expect(await storage.receipts(f.input)).toHaveLength(1)
    expect(await intents(f)).toHaveLength(2)
  })

  it('serializes different sources competing for the same successor slot', async ({
    signal,
    onTestFinished,
  }) => {
    const first = await setup()
    const second = await createHandoffTestFixture(db, {
      candidate: first.candidate,
      applyContext: { notify },
    })
    await approve(first)
    await approve(second)
    const original = await bookings(second)
    const completed = Promise.withResolvers<void>()
    onTestFinished(() => completed.promise)

    let competing: ReturnType<typeof apply> | undefined
    let competingFinished = false
    let lockType: string | undefined
    try {
      await expect(
        applyDepartureHandoff(
          {
            ...first.ctx,
            async notify(trx, event, now) {
              await notify(trx, event, now)
              if (event.type !== 'cancelled') return
              // The first apply is past host locking but has not occupied the slot yet.
              // Use its own connection to wait for the competing apply's actual lock wait.
              competing = apply(second)
              const finished = () => {
                competingFinished = true
              }
              void competing.then(finished, finished)
              while (!competingFinished) {
                signal.throwIfAborted()
                const { rows } = await sql<{ locktype: string }>`
                  SELECT locktype FROM pg_locks
                  WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`.execute(trx)
                if (rows[0]) {
                  lockType = rows[0].locktype
                  return
                }
                await setTimeout(10, undefined, { signal })
              }
            },
          },
          first.input,
          storage.store,
        ),
      ).resolves.toMatchObject({ sourceBookingId: first.booking.id })
      expect(competing).toBeDefined()
      await expect(competing).rejects.toMatchObject({ kind: 'conflict', code: 'slot_unavailable' })
      expect(lockType).toBe('advisory')
      expect(await bookings(first)).toHaveLength(2)
      await expectUnchanged(second, original)
    } finally {
      await competing?.catch(() => {})
      completed.resolve()
    }
  })

  for (const action of ['cancel', 'reschedule'] as const) {
    it(`lets ordinary ${action} win when it holds the booking first`, async (testContext) => {
      const f = await setup()
      await approve(f)
      const guest = () => guestChange(f, action)
      const { firstResult, secondResult } = await race(f, guest, () => apply(f), testContext)
      expect(firstResult).toMatchObject({ status: 'fulfilled' })
      expect(secondResult).toMatchObject({ status: 'rejected', reason: ineligible })
      expect(await storage.receipts(f.input)).toEqual([])
      const rows = await bookings(f)
      expect(rows).toHaveLength(action === 'cancel' ? 1 : 2)
      expect(rows.find((row) => row.id === f.booking.id)).toMatchObject({ status: 'cancelled' })
      if (action === 'reschedule') {
        expect(rows.find((row) => row.id !== f.booking.id)).toMatchObject({
          status: 'confirmed',
          required_host_user_ids: [f.departing.id],
          rescheduled_from_id: f.booking.id,
        })
      }
    })

    it(`keeps the new chain isolated from a losing ordinary ${action}`, async (testContext) => {
      const f = await setup()
      await approve(f)
      const guest = () => guestChange(f, action)
      const { firstResult, secondResult } = await race(f, () => apply(f), guest, testContext)
      expect(firstResult).toMatchObject({ status: 'fulfilled' })
      expect(secondResult).toMatchObject({
        status: 'rejected',
        reason: { kind: 'conflict', code: 'booking_cancelled' },
      })
      expect(await storage.receipts(f.input)).toHaveLength(1)
      const rows = await bookings(f)
      expect(rows).toHaveLength(2)
      expect(rows.find((row) => row.id !== f.booking.id)).toMatchObject({
        status: 'confirmed',
        required_host_user_ids: [f.candidate.id],
        rescheduled_from_id: null,
      })
    })
  }

  async function guestChange(f: Fixture, action: 'cancel' | 'reschedule'): Promise<unknown> {
    return action === 'cancel'
      ? cancelManagedBooking(f.ctx, f.manageToken)
      : rescheduleManagedBooking(f.ctx, f.manageToken, { start: movedStart })
  }
})
