import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import { applyDepartureHandoff } from './departure-handoff-apply.ts'
import {
  createHandoffTestFixture,
  HANDOFF_END,
  HANDOFF_NOW,
  HANDOFF_START,
} from './departure-handoff-apply-test-fixture.ts'
import { departureHandoffTokenDigest } from './departure-handoff-delivery.ts'
import {
  answerDepartureHandoffParticipantOffer,
  readDepartureHandoffParticipantOffer,
} from './departure-handoff-participant.ts'
import {
  createDepartureHandoffProposal,
  readDepartureHandoffProposal,
  resendDepartureHandoffProposal,
  withdrawDepartureHandoffProposal,
} from './departure-handoff-proposals.ts'
import { departureHandoffStore } from './departure-handoff-store.ts'

const adminUrl = process.env.DATABASE_URL
const booker = 'booker@example.test'
const guest = 'guest@example.test'
const unavailable = { kind: 'not_found', code: 'handoff_offer_unavailable' }
const changed = { kind: 'conflict', code: 'handoff_offer_changed' }
const queue = async () => randomUUID()

describe.skipIf(!adminUrl)('departure handoff participant consent', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(adminUrl as string, undefined, { tag: 'handoff_consent' })
    owned.pool.options.max = 5
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(options?: Parameters<typeof createHandoffTestFixture>[1]) {
    let now = HANDOFF_NOW
    const f = await createHandoffTestFixture(db, { ...options, now: () => now })
    const publicContext = { db, now: f.ctx.now }
    const input = {
      bookingId: f.booking.id,
      teamId: f.team.id,
      expectedOrganizationId: f.team.id,
      departingUserId: f.departing.id,
    }
    const propose = (previous?: { id: string; version: number }, start?: Temporal.Instant) =>
      createDepartureHandoffProposal(
        f.ctx,
        {
          ...input,
          ...(previous && { previous: { offerId: previous.id, version: previous.version } }),
          ...(start && { start: start.toString() }),
        },
        queue,
      )
    const key = (offer: { id: string; version: number }) => ({
      ...input,
      offerId: offer.id,
      version: offer.version,
    })
    const rows = (version: number) =>
      db
        .selectFrom('departure_handoff_recipients')
        .select(['id', 'recipient_key', 'decision', 'decided_at', 'token_digest'])
        .where('organization_id', '=', f.team.id)
        .where('source_booking_id', '=', f.booking.id)
        .where('offer_version', '=', version)
        .orderBy('recipient_key')
        .execute()
    async function issueToken(version: number, mailbox: string) {
      const recipient = (await rows(version)).find(({ recipient_key }) => recipient_key === mailbox)
      if (!recipient) throw new Error('Missing test recipient')
      const secret = randomBytes(32).toString('base64url')
      await db
        .updateTable('departure_handoff_recipients')
        .set({ token_digest: departureHandoffTokenDigest(recipient.id, secret) })
        .where('id', '=', recipient.id)
        .execute()
      return { id: recipient.id, secret, token: `${recipient.id}.${secret}` }
    }
    const initial = await propose()
    return {
      f,
      initial,
      propose,
      key,
      rows,
      issueToken,
      moveClock: (time: Temporal.Instant) => {
        now = time
      },
      read: (token: string) => readDepartureHandoffParticipantOffer(publicContext, token),
      answer: (token: string, version: number, decision: 'accept' | 'decline' = 'accept') =>
        answerDepartureHandoffParticipantOffer(publicContext, { token, version, decision }),
      apply: (offer: { id: string; version: number }) =>
        applyDepartureHandoff(f.ctx, key(offer), departureHandoffStore),
    }
  }

  it('projects only safe terms and the booker’s own answers without recording consent', async () => {
    const setAddress = (eventTypeId: string, address: string) =>
      db
        .updateTable('event_types')
        .set({ location: JSON.stringify({ kind: 'in_person', address }) })
        .where('id', '=', eventTypeId)
        .execute()
    const s = await setup({
      configureSource: async ({ eventTypeId }) => {
        await setAddress(eventTypeId, 'Old meeting address')
      },
      configureTarget: async ({ eventTypeId }) => {
        await setAddress(eventTypeId, 'New meeting address')
      },
    })
    const b = await s.issueToken(1, booker)
    const g = await s.issueToken(1, guest)
    const shared = {
      version: 1,
      expiresAt: HANDOFF_START.toString(),
      current: {
        start: HANDOFF_START.toString(),
        end: HANDOFF_END.toString(),
        timeZone: 'UTC',
        hostName: 'Departing host',
        location: { kind: 'in_person', address: 'Old meeting address' },
      },
      proposed: {
        start: HANDOFF_START.toString(),
        end: HANDOFF_END.toString(),
        timeZone: 'UTC',
        hostName: 'Replacement host',
        location: { kind: 'in_person', address: 'New meeting address' },
      },
    }
    const ownOffer = {
      ...shared,
      role: 'booker',
      answers: [{ label: 'Notes', value: 'Approved answer' }],
    }
    await expect(s.read(b.token)).resolves.toEqual(ownOffer)
    await expect(s.read(b.token)).resolves.toEqual(ownOffer)
    await expect(s.read(g.token)).resolves.toEqual({ ...shared, role: 'guest', answers: [] })
    const mixed = `${b.id}.${g.secret}`
    await expect(s.read(mixed)).rejects.toMatchObject(unavailable)
    await expect(s.answer(mixed, 1)).rejects.toMatchObject(unavailable)
    await expect(s.read(s.f.manageToken)).rejects.toMatchObject(unavailable)
    await expect(s.answer(s.f.manageToken, 1)).rejects.toMatchObject(unavailable)
    expect((await s.rows(1)).map(({ decision, decided_at }) => [decision, decided_at])).toEqual([
      [null, null],
      [null, null],
    ])
  })

  it('excludes private participant phone numbers from logistical terms', async () => {
    const s = await setup({
      configureSource: async ({ eventTypeId }) => {
        await db
          .updateTable('event_types')
          .set({ location: JSON.stringify({ kind: 'phone', number: '+12025550123' }) })
          .where('id', '=', eventTypeId)
          .execute()
      },
    })
    const { token } = await s.issueToken(1, guest)
    const offer = await s.read(token)
    expect(offer.current.location).toEqual({ kind: 'phone' })
    expect(offer.proposed.location).toEqual({ kind: 'phone' })
  })

  it('rejects expired and withdrawn capabilities without changing consent', async () => {
    const s = await setup()
    const b = await s.issueToken(1, booker)
    s.moveClock(HANDOFF_START)
    await expect(s.read(b.token)).rejects.toMatchObject(unavailable)
    await expect(s.answer(b.token, 1)).rejects.toMatchObject(unavailable)
    s.moveClock(HANDOFF_NOW)
    await withdrawDepartureHandoffProposal(s.f.ctx, s.key(s.initial))
    await expect(s.read(b.token)).rejects.toMatchObject(unavailable)
    await expect(s.answer(b.token, 1, 'decline')).rejects.toMatchObject(unavailable)
    expect(
      (await s.rows(1)).every((row) => row.decision === null && row.token_digest === null),
    ).toBe(true)
  })

  it('hides closed terms even when the recipient digest is still present', async () => {
    const s = await setup()
    const b = await s.issueToken(1, booker)
    await expect(s.read(b.token)).resolves.toMatchObject({ version: s.initial.version })

    // Leave the digest intact to exercise the offer state guard independently.
    const { offerId, version, bookingId, teamId } = s.key(s.initial)
    await db
      .updateTable('departure_handoff_offers')
      .set({ state: 'closed', close_reason: 'withdrawn' })
      .where('organization_id', '=', teamId)
      .where('source_booking_id', '=', bookingId)
      .where('id', '=', offerId)
      .where('version', '=', version)
      .executeTakeFirstOrThrow()

    const digest = departureHandoffTokenDigest(b.id, b.secret)
    expect(await s.rows(version)).toContainEqual(
      expect.objectContaining({ id: b.id, token_digest: digest, decision: null }),
    )
    await expect(s.read(b.token)).rejects.toMatchObject(unavailable)
  })

  it('refuses newly edited terms and a different expected version', async () => {
    const s = await setup()
    const b = await s.issueToken(1, booker)
    await expect(s.answer(b.token, 2)).rejects.toMatchObject(unavailable)
    await expect(s.read(b.token)).resolves.toMatchObject({ version: 1 })
    await db
      .updateTable('bookings')
      .set({ responses: JSON.stringify({ notes: 'Edited after proposing' }) })
      .where('id', '=', s.f.booking.id)
      .execute()
    await expect(s.read(b.token)).rejects.toMatchObject(unavailable)
    await expect(s.answer(b.token, 1)).rejects.toMatchObject(unavailable)
    expect((await s.rows(1)).map(({ decision }) => decision)).toEqual([null, null])
  })

  it('records one answer when the same recipient submits two decisions concurrently', async () => {
    const s = await setup()
    const b = await s.issueToken(1, booker)
    const results = await Promise.allSettled([
      s.answer(b.token, 1),
      s.answer(b.token, 1, 'decline'),
    ])
    const successes = results.filter((result) => result.status === 'fulfilled')
    expect(successes).toHaveLength(1)
    const accepted = successes[0]?.value.decision === 'accept'
    expect(
      results.filter((result) => result.status === 'rejected').map(({ reason }) => reason),
    ).toEqual([expect.objectContaining(unavailable)])
    const [record, other] = await s.rows(1)
    expect(record).toMatchObject({
      id: b.id,
      decision: accepted ? 'approved' : 'declined',
      decided_at: new Date(HANDOFF_NOW.epochMilliseconds),
      token_digest: null,
    })
    expect(other?.decision).toBeNull()
    await expect(s.read(b.token)).rejects.toMatchObject(unavailable)
    await expect(s.answer(b.token, 1)).rejects.toMatchObject(unavailable)
  })

  it('keeps the source confirmed when a guest stays silent or declines and requires consent again on reissue', async () => {
    const s = await setup()
    const b = await s.issueToken(1, booker)
    const g = await s.issueToken(1, guest)
    await expect(s.answer(b.token, 1)).resolves.toEqual({ decision: 'accept' })
    await expect(s.apply(s.initial)).rejects.toMatchObject({ code: 'handoff_consent_required' })
    await expect(s.answer(g.token, 1, 'decline')).resolves.toEqual({ decision: 'decline' })
    await expect(s.apply(s.initial)).rejects.toMatchObject(changed)
    await expect(
      resendDepartureHandoffProposal(
        s.f.ctx,
        { ...s.key(s.initial), recipientId: g.id, requestKey: randomUUID() },
        queue,
      ),
    ).rejects.toMatchObject(changed)
    await expect(readDepartureHandoffProposal(s.f.ctx, s.key(s.initial))).resolves.toMatchObject({
      state: 'closed',
      recipients: expect.arrayContaining([
        expect.objectContaining({
          decision: 'declined',
          resendAvailable: false,
          delivery: 'skipped',
        }),
      ]),
    })
    const newOffer = await s.propose(s.initial)
    expect(newOffer.version).toBe(2)
    await expect(s.read(g.token)).rejects.toMatchObject(unavailable)
    const freshBooker = await s.issueToken(2, booker)
    const freshGuest = await s.issueToken(2, guest)
    await expect(s.answer(freshGuest.token, 2)).resolves.toEqual({ decision: 'accept' })
    await expect(s.apply(newOffer)).rejects.toMatchObject({ code: 'handoff_consent_required' })
    expect(
      await db
        .selectFrom('bookings')
        .select('status')
        .where('id', '=', s.f.booking.id)
        .executeTakeFirst(),
    ).toEqual({ status: 'confirmed' })
    await expect(s.answer(freshBooker.token, 2)).resolves.toEqual({ decision: 'accept' })
    await expect(s.apply(newOffer)).resolves.toMatchObject({ sourceBookingId: s.f.booking.id })
  })

  async function waitForBookingLock(blockerPid: number, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted()
      const { rows } = await owned.pool.query<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype = 'tuple' AND relation = 'bookings'::regclass
           AND $1 = ANY(pg_blocking_pids(pid))`,
        [blockerPid],
      )
      if (rows[0]) return rows[0].pid
      await setTimeout(10, undefined, { signal })
    }
  }

  async function race<A, B>(
    bookingId: string,
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
    const requests: Promise<unknown>[] = []
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM bookings WHERE id = $1 FOR UPDATE', [bookingId])
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const holderPid = rows[0]?.pid
      if (holderPid === undefined) throw new Error('Missing lock holder backend')
      const winner = Promise.allSettled([first()])
      requests.push(winner)
      const winnerPid = await waitForBookingLock(holderPid, signal)
      const loser = Promise.allSettled([second()])
      requests.push(loser)
      await waitForBookingLock(winnerPid, signal)
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

  it('rejects an in-flight decision when re-version obtains the source lock first', async (testContext) => {
    const s = await setup()
    const b = await s.issueToken(1, booker)
    const { firstResult, secondResult } = await race(
      s.f.booking.id,
      () => s.propose(s.initial),
      () => s.answer(b.token, 1),
      testContext,
    )
    expect(firstResult).toMatchObject({ status: 'fulfilled', value: { version: 2 } })
    expect(secondResult).toMatchObject({ status: 'rejected', reason: unavailable })
    expect((await s.rows(1)).map(({ decision }) => decision)).toEqual([null, null])
    expect((await s.rows(2)).map(({ decision }) => decision)).toEqual([null, null])
  })

  it('preserves a winning decision as history bound to its old version', async (testContext) => {
    const s = await setup()
    const b = await s.issueToken(1, booker)
    const { firstResult, secondResult } = await race(
      s.f.booking.id,
      () => s.answer(b.token, 1),
      () => s.propose(s.initial),
      testContext,
    )
    expect(firstResult).toMatchObject({ status: 'fulfilled', value: { decision: 'accept' } })
    expect(secondResult).toMatchObject({ status: 'fulfilled', value: { version: 2 } })
    expect((await s.rows(1)).map(({ decision }) => decision)).toEqual(['approved', null])
    expect((await s.rows(2)).map(({ decision }) => decision)).toEqual([null, null])
    await expect(s.read(b.token)).rejects.toMatchObject(unavailable)
  })
})
