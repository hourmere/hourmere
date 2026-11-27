import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs, type Jobs } from '@hourmere/jobs'
import type { Mailer, WorkflowSmtpAttemptOutcome } from '@hourmere/mail'
import {
  DEPARTURE_HANDOFF_EMAIL_JOB,
  deliverDepartureHandoffEmail,
  departureHandoffEmailJob,
} from '@hourmere/notifications'
import { departureHandoffTokenDigest } from '@hourmere/scheduling/departure-handoff-delivery'
import {
  cleanupDepartureHandoffProposals,
  createDepartureHandoffProposal,
  readDepartureHandoffProposal,
  resendDepartureHandoffProposal,
  withdrawDepartureHandoffProposal,
} from '@hourmere/scheduling/departure-handoff-proposals'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createHandoffTestFixture,
  HANDOFF_NOW,
  HANDOFF_START,
  handoffTestSession,
} from '../../../../packages/scheduling/src/departure-handoff-apply-test-fixture.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'https://handoff.example.test'
const bookerMailbox = 'booker@example.test'
const guestMailbox = 'guest@example.test'
const jobDefinition = departureHandoffEmailJob()

describe.skipIf(!serverUrl)('departure handoff proposals and delivery', () => {
  let owned: TestDatabase
  let db: Db
  let jobs: Jobs<readonly [typeof jobDefinition]>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'handoff_proposal' })
    db = createDb(owned.pool)
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [jobDefinition] as const,
      work: false,
      migrate: true,
      maxConnections: 2,
      log: () => {},
    })
    await jobs.start()
  })

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  async function enqueue(trx: Db, recipientId: string) {
    const id = await jobs.enqueue(
      DEPARTURE_HANDOFF_EMAIL_JOB,
      { recipientId },
      { transaction: trx },
    )
    if (!id) throw new Error('Missing handoff job')
    return id
  }

  async function fixture() {
    let now = HANDOFF_NOW
    const f = await createHandoffTestFixture(db, { now: () => now })
    const input = {
      teamId: f.team.id,
      expectedOrganizationId: f.team.id,
      bookingId: f.booking.id,
      departingUserId: f.departing.id,
    }
    const propose = (previous?: { id: string; version: number }) =>
      createDepartureHandoffProposal(
        f.ctx,
        {
          ...input,
          ...(previous && { previous: { offerId: previous.id, version: previous.version } }),
        },
        enqueue,
      )
    const key = (offer: { id: string; version: number }) => ({
      ...input,
      offerId: offer.id,
      version: offer.version,
    })
    const read = (offer: { id: string; version: number }) =>
      readDepartureHandoffProposal(f.ctx, key(offer))
    const resend = (
      offer: { id: string; version: number },
      recipientId: string,
      requestKey = randomUUID(),
    ) => resendDepartureHandoffProposal(f.ctx, { ...key(offer), recipientId, requestKey }, enqueue)
    const withdraw = (offer: { id: string; version: number }) =>
      withdrawDepartureHandoffProposal(f.ctx, key(offer))
    const recipients = (offer: { id: string; version: number }) =>
      db
        .selectFrom('departure_handoff_recipients')
        .select(['id', 'token_digest', 'recipient_key', 'decision'])
        .where('source_booking_id', '=', f.booking.id)
        .where('offer_id', '=', offer.id)
        .where('offer_version', '=', offer.version)
        .orderBy('recipient_key')
        .execute()
    const budget = async () =>
      (
        await db
          .selectFrom('departure_handoff_send_budgets')
          .select('counted_sends')
          .where('source_booking_id', '=', f.booking.id)
          .orderBy('counted_sends')
          .execute()
      ).map((row) => row.counted_sends)
    const source = () =>
      db
        .selectFrom('bookings')
        .select(['id', 'status', 'location', 'responses', 'required_host_user_ids'])
        .where('organization_id', '=', f.team.id)
        .execute()
    const occupancy = () =>
      db
        .selectFrom('booking_hosts')
        .select(['user_id', 'active', 'period'])
        .where('booking_id', '=', f.booking.id)
        .execute()
    const expectSourcePreserved = async () => {
      expect(await source()).toEqual(originalSource)
      expect(await occupancy()).toEqual(originalOccupancy)
      expect(
        await db
          .selectFrom('departure_booking_handoffs')
          .select('source_booking_id')
          .where('source_booking_id', '=', f.booking.id)
          .execute(),
      ).toEqual([])
    }
    const originalSource = await source()
    const originalOccupancy = await occupancy()
    return {
      ...f,
      input,
      key,
      propose,
      read,
      resend,
      withdraw,
      budget,
      recipients,
      expectSourcePreserved,
      setNow: (instant: Temporal.Instant) => {
        now = instant
      },
    }
  }

  function intents(recipientId: string) {
    return db
      .selectFrom('departure_handoff_deliveries')
      .select(['job_id', 'recipient_id', 'request_key', 'state'])
      .where('recipient_id', '=', recipientId)
      .orderBy('created_at')
      .orderBy('job_id')
      .execute()
  }

  async function queued(recipientId: string) {
    const rows = await intents(recipientId)
    const pending = rows.filter((row) => row.state === 'queued')
    expect(pending).toHaveLength(1)
    if (!pending[0]) throw new Error('Missing queued handoff intent')
    return pending[0]
  }

  function deliver(
    f: Awaited<ReturnType<typeof fixture>>,
    intent: { job_id: string; recipient_id: string },
    mailer: Mailer,
  ) {
    return deliverDepartureHandoffEmail(
      {
        db,
        mailer,
        now: f.ctx.now,
        publicUrl,
        secret: 'synthetic-departure-handoff-test-accounting-secret',
        // The synthetic fixtures use the same mailboxes and clock across this test file.
        mailRecipientMaxPerHour: 20,
      },
      { recipientId: intent.recipient_id },
      { id: intent.job_id, signal: new AbortController().signal },
    )
  }

  function transport(outcome: WorkflowSmtpAttemptOutcome = 'sent') {
    const send = vi.fn<Mailer['send']>(async () => {})
    const sendWorkflowAttempt = vi.fn<NonNullable<Mailer['sendWorkflowAttempt']>>(
      async () => outcome,
    )
    return { send, sendWorkflowAttempt }
  }

  function token(message: string, recipientId: string) {
    const rawLink = message.match(/https:\/\/handoff\.example\.test\/\S+/)?.[0]
    if (!rawLink) throw new Error('Missing participant link')
    const link = new URL(rawLink)
    expect(link.origin).toBe(publicUrl)
    expect(link.pathname).toBe('/booking-handoffs/offer')
    expect(link.search).toBe('')
    const [id, secret, extra] = (new URLSearchParams(link.hash.slice(1)).get('token') ?? '').split(
      '.',
    )
    expect(id === recipientId && extra === undefined && /^[\w-]{43}$/.test(secret ?? '')).toBe(true)
    if (!secret) throw new Error('Missing participant secret')
    return secret
  }

  it('deduplicates saved mailboxes and keeps addresses, answers and capability material private', async () => {
    const f = await fixture()
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: f.booking.id,
        email: ' BOOKER@EXAMPLE.TEST ',
        name: 'Duplicate Attendee',
        time_zone: 'UTC',
      })
      .execute()
    const savedGuestAddress = 'Guest@example.test'
    await db
      .updateTable('booking_attendees')
      .set({ email: savedGuestAddress })
      .where('booking_id', '=', f.booking.id)
      .where('email', '=', guestMailbox)
      .execute()
    await db
      .updateTable('booking_attendees')
      .set({ locale: 'zh-CN' })
      .where('booking_id', '=', f.booking.id)
      .where('is_booker', '=', true)
      .execute()
    const offer = await f.propose()
    expect(offer).toMatchObject({ version: 1, expiresAt: HANDOFF_START.toString() })
    const saved = await f.recipients(offer)
    expect(saved).toMatchObject([
      { recipient_key: bookerMailbox, token_digest: null, decision: null },
      { recipient_key: guestMailbox, token_digest: null, decision: null },
    ])
    expect(offer.recipients.map(({ id }) => id).sort()).toEqual(saved.map(({ id }) => id).sort())
    const booker = saved.find(({ recipient_key }) => recipient_key === bookerMailbox)
    if (!booker) throw new Error('Missing booker')
    const sourceAttendees = await db
      .selectFrom('booking_attendees')
      .select(['id', 'email'])
      .where('booking_id', '=', f.booking.id)
      .orderBy('id')
      .execute()
    expect(offer.recipients.find(({ id }) => id === booker.id)?.attendeeIds).toEqual(
      sourceAttendees
        .filter(({ email }) => email.trim().toLowerCase() === bookerMailbox)
        .map(({ id }) => id),
    )
    const job = await queued(booker.id)
    expect(
      (await owned.pool.query('SELECT data FROM pgboss.job WHERE id = $1', [job.job_id])).rows,
    ).toEqual([{ data: { recipientId: booker.id } }])
    const mailer = transport()
    await deliver(f, job, mailer)
    expect(mailer.sendWorkflowAttempt).toHaveBeenCalledTimes(1)
    const message = mailer.sendWorkflowAttempt.mock.calls[0]?.[0]
    if (!message) throw new Error('Missing sent handoff email')
    expect(message.to).toBe(bookerMailbox)
    expect(message.sensitive).toBe(true)
    expect(message.attachments).toBeUndefined()
    const issuedToken = token(message.text, booker.id)
    const stored = (await f.recipients(offer)).find(({ id }) => id === booker.id)?.token_digest
    expect(stored === departureHandoffTokenDigest(booker.id, issuedToken)).toBe(true)
    const guest = saved.find(({ recipient_key }) => recipient_key === guestMailbox)
    if (!guest) throw new Error('Missing guest')
    await deliver(f, await queued(guest.id), mailer)
    const guestMessage = mailer.sendWorkflowAttempt.mock.calls[1]?.[0]
    expect(guestMessage?.to).toBe(savedGuestAddress)
    expect(guestMessage?.subject).toBe('查看预约变更提议')
    const projection = JSON.stringify(await f.read(offer))
    for (const privateValue of [
      bookerMailbox,
      guestMailbox,
      'Private Booker',
      'Private Guest',
      'Approved answer',
      issuedToken,
      stored,
    ]) {
      expect(Boolean(privateValue && projection.includes(privateValue))).toBe(false)
    }
    await f.expectSourcePreserved()
  })

  it('serializes concurrent resend replays and replaces only the intended recipient link', async () => {
    const f = await fixture()
    const offer = await f.propose()
    const [booker, guest] = await f.recipients(offer)
    if (!booker || !guest) throw new Error('Missing consent recipients')
    const initial = await queued(booker.id)
    const mailer = transport()
    await deliver(f, initial, mailer)
    await db
      .updateTable('departure_handoff_recipients')
      .set({ decision: 'approved', decided_at: HANDOFF_NOW.toString() })
      .where('id', '=', guest.id)
      .execute()
    const first = (await f.recipients(offer))[0]?.token_digest
    expect(Boolean(first)).toBe(true)
    const requestKey = randomUUID()
    const replays = await Promise.all([
      f.resend(offer, booker.id, requestKey),
      f.resend(offer, booker.id, requestKey),
    ])
    expect(replays[0]).toEqual(replays[1])
    const second = await queued(booker.id)
    expect(second.job_id).not.toBe(initial.job_id)
    expect(second.request_key).toBe(requestKey)
    expect(await intents(booker.id)).toHaveLength(2)
    await Promise.all([deliver(f, second, mailer), deliver(f, second, mailer)])
    expect(mailer.sendWorkflowAttempt).toHaveBeenCalledTimes(2)
    const updated = await f.recipients(offer)
    const newest = updated[0]?.token_digest
    expect(Boolean(newest) && newest !== first).toBe(true)
    expect(updated[1]).toMatchObject({ id: guest.id, decision: 'approved', token_digest: null })
    await deliver(f, initial, mailer)
    await f.resend(offer, booker.id, requestKey)
    expect(mailer.sendWorkflowAttempt).toHaveBeenCalledTimes(2)
    expect(await intents(booker.id)).toHaveLength(2)
    expect((await f.recipients(offer))[0]?.token_digest === newest).toBe(true)
    expect(await f.budget()).toEqual([2])
    await f.expectSourcePreserved()
  })

  it('revokes old links on reissue and counts ambiguous deliveries toward a cross-version cap', async () => {
    const f = await fixture()
    const first = await f.propose()
    const [oldBooker, oldGuest] = await f.recipients(first)
    if (!oldBooker || !oldGuest) throw new Error('Missing original recipients')
    const mailer = transport()
    await deliver(f, await queued(oldBooker.id), mailer)
    expect(Boolean((await f.recipients(first))[0]?.token_digest)).toBe(true)
    const olderGuest = await queued(oldGuest.id)
    const second = await f.propose(first)
    expect(second.version).toBe(2)
    expect(
      (await f.recipients(first)).map(({ id, decision, token_digest }) => ({
        id,
        decision,
        hasLink: Boolean(token_digest),
      })),
    ).toEqual([
      { id: oldBooker.id, hasLink: false, decision: null },
      { id: oldGuest.id, hasLink: false, decision: null },
    ])
    await deliver(f, olderGuest, mailer)
    expect(mailer.sendWorkflowAttempt).toHaveBeenCalledTimes(1)
    const [booker, guest] = await f.recipients(second)
    if (!booker || !guest) throw new Error('Missing versioned recipients')
    expect(booker.id !== oldBooker.id && booker.decision === null).toBe(true)
    const uncertain = transport('delivery_unknown')
    const newJob = await queued(booker.id)
    await deliver(f, newJob, uncertain)
    await deliver(f, newJob, uncertain)
    expect(uncertain.sendWorkflowAttempt).toHaveBeenCalledTimes(1)
    expect(await f.budget()).toEqual([2])
    expect((await f.read(second)).recipients.find(({ id }) => id === booker.id)).toMatchObject({
      delivery: 'unknown',
    })
    await f.resend(second, booker.id)
    await deliver(f, await queued(booker.id), mailer)
    expect(await f.budget()).toEqual([3])
    expect((await f.read(second)).recipients.find(({ id }) => id === booker.id)).toMatchObject({
      resendAvailable: false,
    })
    const exhausted = { kind: 'conflict', code: 'handoff_send_limit' }
    await expect(f.resend(second, booker.id)).rejects.toMatchObject(exhausted)
    await expect(f.propose(second)).rejects.toMatchObject(exhausted)
    expect((await f.read(second)).state).toBe('live')
    await deliver(f, await queued(guest.id), mailer)
    expect(await f.budget()).toEqual([1, 3])
    await f.expectSourcePreserved()
  })

  it('withdraws during an SMTP send and prevents its late outcome from restoring a link', async ({
    signal,
  }) => {
    const f = await fixture()
    const offer = await f.propose()
    const [booker, guest] = await f.recipients(offer)
    if (!booker || !guest) throw new Error('Missing recipients to withdraw')
    const initial = await queued(booker.id)
    const unsent = await queued(guest.id)
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<WorkflowSmtpAttemptOutcome>()
    const sendWorkflowAttempt = vi.fn<NonNullable<Mailer['sendWorkflowAttempt']>>(() => {
      started.resolve()
      return finish.promise
    })
    const mailer = { send: vi.fn<Mailer['send']>(async () => {}), sendWorkflowAttempt }
    const release = () => finish.resolve('sent')
    signal.addEventListener('abort', release, { once: true })
    const delivery = deliver(f, initial, mailer)
    try {
      await Promise.race([
        started.promise,
        delivery.then(() => {
          throw new Error('The send finished before reaching SMTP')
        }),
      ])
      expect((await f.recipients(offer)).some(({ token_digest }) => token_digest !== null)).toBe(
        true,
      )
      await f.withdraw(offer)
      expect((await f.recipients(offer)).every(({ token_digest }) => token_digest === null)).toBe(
        true,
      )
      await deliver(f, unsent, mailer)
    } finally {
      release()
      await delivery
      signal.removeEventListener('abort', release)
    }
    expect(sendWorkflowAttempt).toHaveBeenCalledTimes(1)
    expect((await f.recipients(offer)).every(({ token_digest }) => token_digest === null)).toBe(
      true,
    )
    expect(await f.budget()).toEqual([1])
    await expect(f.resend(offer, booker.id)).rejects.toMatchObject({
      kind: 'conflict',
      code: 'handoff_offer_changed',
    })
    await f.expectSourcePreserved()
  })

  it('shows mail as unavailable without minting a link and skips work after the proposal deadline', async () => {
    const f = await fixture()
    const offer = await f.propose()
    const [booker, guest] = await f.recipients(offer)
    if (!booker || !guest) throw new Error('Missing recipients')
    const logMailer = { send: vi.fn<Mailer['send']>(async () => {}) }
    await deliver(f, await queued(booker.id), logMailer)
    expect(logMailer.send).not.toHaveBeenCalled()
    expect((await f.read(offer)).recipients.find(({ id }) => id === booker.id)).toMatchObject({
      delivery: 'unavailable',
    })
    f.setNow(HANDOFF_START)
    const mailer = transport()
    await deliver(f, await queued(guest.id), mailer)
    expect(mailer.sendWorkflowAttempt).not.toHaveBeenCalled()
    expect((await f.read(offer)).state).toBe('expired')
    expect((await f.recipients(offer)).every(({ token_digest }) => token_digest === null)).toBe(
      true,
    )
    expect(await f.budget()).toEqual([])
    await f.expectSourcePreserved()
  })

  it('replaces a stalled queued intent and prunes expired mail data without restoring the budget', async () => {
    const f = await fixture()
    const offer = await f.propose()
    const [booker] = await f.recipients(offer)
    if (!booker) throw new Error('Missing booker')
    const stalled = await queued(booker.id)
    await db
      .updateTable('departure_handoff_deliveries')
      .set({ created_at: new Date(Date.now() - 30 * 60_000) })
      .where('job_id', '=', stalled.job_id)
      .execute()
    expect((await f.read(offer)).recipients.find(({ id }) => id === booker.id)).toMatchObject({
      delivery: 'unavailable',
      resendAvailable: true,
    })
    await f.resend(offer, booker.id)
    const mailer = transport()
    await deliver(f, stalled, mailer)
    expect(mailer.sendWorkflowAttempt).not.toHaveBeenCalled()
    await deliver(f, await queued(booker.id), mailer)
    expect(await f.budget()).toEqual([1])

    f.setNow(HANDOFF_START)
    await cleanupDepartureHandoffProposals(db, HANDOFF_START)
    expect((await f.read(offer)).state).toBe('expired')
    expect((await f.recipients(offer)).every(({ token_digest }) => token_digest === null)).toBe(
      true,
    )

    await cleanupDepartureHandoffProposals(db, HANDOFF_START.add({ hours: 48 }))
    expect(await f.read(offer)).toMatchObject({
      id: offer.id,
      version: offer.version,
      recipients: [],
    })
    expect(await intents(booker.id)).toEqual([])
    expect(await f.budget()).toEqual([1])
    await f.expectSourcePreserved()
  })

  it('refuses ordinary members, API keys, stale organization context and foreign booking ids', async () => {
    const f = await fixture()
    const foreign = await fixture()
    const member = await handoffTestSession(db, f.departing, f.ctx.principal.organization)
    const enqueueNothing = vi.fn(enqueue)
    const create = (
      overrides: Partial<typeof f.input> = {},
      principal: Parameters<typeof createDepartureHandoffProposal>[0]['principal'] = f.ctx
        .principal,
    ) =>
      createDepartureHandoffProposal(
        { ...f.ctx, principal },
        { ...f.input, ...overrides },
        enqueueNothing,
      )
    const denied = { kind: 'forbidden', code: 'team_management_access_denied' }
    await expect(create({}, member)).rejects.toMatchObject(denied)
    await expect(create({}, f.team.as(f.owner))).rejects.toMatchObject(denied)
    await expect(create({ expectedOrganizationId: '' })).rejects.toMatchObject({
      kind: 'conflict',
      code: 'organization_context_changed',
    })
    for (const bookingId of [foreign.booking.id, randomUUID()]) {
      await expect(create({ bookingId })).rejects.toMatchObject({
        kind: 'not_found',
        code: 'booking_not_found',
      })
    }
    expect(enqueueNothing).not.toHaveBeenCalled()
    await f.expectSourcePreserved()
  })

  it('blocks a routing snapshot before writing an offer or queuing mail', async () => {
    const f = await fixture()
    await db
      .insertInto('booking_routing')
      .values({
        booking_id: f.booking.id,
        organization_id: f.team.id,
        form_id: randomUUID(),
        version_id: randomUUID(),
        version_number: 1,
        matched_rule_id: 'fallback',
        resolved_rule_id: 'fallback',
        questions: '[]',
        answers: '{}',
      })
      .execute()
    const enqueueNothing = vi.fn(enqueue)
    await expect(
      createDepartureHandoffProposal(f.ctx, f.input, enqueueNothing),
    ).rejects.toMatchObject({ kind: 'conflict', code: 'handoff_source_ineligible' })
    expect(enqueueNothing).not.toHaveBeenCalled()
    expect(
      await db
        .selectFrom('departure_handoff_offers')
        .select('id')
        .where('source_booking_id', '=', f.booking.id)
        .execute(),
    ).toEqual([])
    await f.expectSourcePreserved()
  })

  it('rolls back the replacement offer and its outbox jobs if enqueue fails mid-version', async () => {
    const f = await fixture()
    const original = await f.propose()
    const queuedIds: string[] = []
    await expect(
      createDepartureHandoffProposal(
        f.ctx,
        { ...f.input, previous: { offerId: original.id, version: original.version } },
        async (trx, recipientId) => {
          if (queuedIds.length) throw new Error('Synthetic enqueue failure')
          const id = await enqueue(trx, recipientId)
          queuedIds.push(id)
          return id
        },
      ),
    ).rejects.toMatchObject({ kind: 'unavailable', code: 'handoff_delivery_unavailable' })
    expect(queuedIds).toHaveLength(1)
    expect(
      (await owned.pool.query('SELECT id FROM pgboss.job WHERE id = ANY($1::uuid[])', [queuedIds]))
        .rows,
    ).toEqual([])
    expect(
      await db
        .selectFrom('departure_handoff_offers')
        .select(['id', 'state', 'version'])
        .where('source_booking_id', '=', f.booking.id)
        .execute(),
    ).toEqual([{ id: original.id, state: 'live', version: 1 }])
    await f.expectSourcePreserved()
  })
})
