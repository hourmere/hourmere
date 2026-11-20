import { randomBytes, randomUUID } from 'node:crypto'
import { calendarBookingNotifier } from '@hourmere/calendars'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { bookingNotifier, sendBookingNotification } from '@hourmere/notifications'
import { webhookBookingNotifier } from '@hourmere/webhooks'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Booking,
  cancelHostBooking,
  cancelManagedBooking,
  createPublicTeamBooking,
  createRoutedBooking,
  getManagedBooking,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import type { BookingNotifier } from './context.ts'
import { createEventType } from './event-types.ts'
import {
  archiveRoutingForm,
  createRoutingForm,
  publishRoutingForm,
  submitRoutingForm,
  updateRoutingForm,
} from './routing-form-service.ts'
import { routingTokenDigest } from './routing-receipt-crypto.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2030-10-07T08:00:00Z')
const start = () => now().add({ hours: 3 })
const responses = { topic: 'Final booking answer' }
const privateAnswer = 'Private routing answer from the original version'
const routingSecret = randomBytes(32).toString('base64url')

describe.skipIf(!serverUrl)('routed booking management', () => {
  let owned: TestDatabase
  let db: Db
  let observed: Db
  const statements: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'routing_moves' })
    db = createDb(owned.pool)
    observed = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture() {
    const owner = await createTestUser(db, 'Original host')
    const coHost = await createTestUser(db, 'Original co-host')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: coHost, role: 'member' },
    ])
    const fixtures = createFixtures(db)
    const hosts = [owner.id, coHost.id].sort()
    for (const userId of hosts) {
      await db
        .insertInto('profiles')
        .values({ user_id: userId, handle: `host-${userId.slice(0, 8)}`, time_zone: 'UTC' })
        .execute()
      await fixtures.schedule(userId, { timeZone: 'UTC' })
    }
    const slug = 'consultation'
    const principal = team.as(owner)
    const author = testContext(
      db,
      {
        kind: 'session',
        sessionId: randomUUID(),
        user: principal.user,
        organization: principal.organization,
      },
      now,
    )
    const { id: eventTypeId } = await createEventType(author, {
      slug,
      title: 'Collective appointment',
      durationMinutes: 30,
      schedulingType: 'collective',
      hosts: hosts.map((userId) => ({ userId })),
      questions: [{ id: 'topic', label: 'Booking topic', type: 'short_text', required: true }],
    })
    const invitee = {
      name: 'Ivana Invitee',
      email: `ivana-${owner.id}@example.test`,
      timeZone: 'UTC',
    }
    const request = { start: start(), invitee, responses, idempotencyKey: randomUUID() }
    const bookings = { ...request, handle: principal.organization.slug, slug }
    const routingContext = { db, now, receiptNow: now, routingSecret, routingFormsEnabled: true }
    async function issue() {
      const questionId = randomUUID()
      const { id } = await createRoutingForm(author, {
        slug: 'intake',
        title: 'Private intake',
        questions: [{ id: questionId, label: 'Private routing label', type: 'short_text' }],
        rules: [],
        fallback: { kind: 'event', eventTypeId, mappings: [] },
      })
      const { form, version } = await publishRoutingForm(author, id, { expectedRevision: 1 })
      const enabled = await updateRoutingForm(author, id, {
        expectedRevision: form.draftRevision,
        enabled: true,
      })
      const receipt = await submitRoutingForm(
        routingContext,
        { organizationId: team.id, formId: id },
        { versionId: version.id, answers: { [questionId]: privateAnswer } },
      )
      if (receipt.kind !== 'continuation') throw new Error('Expected a routing receipt')
      return { input: { ...request, routeToken: receipt.routeToken }, enabled, version }
    }
    return {
      author,
      hosts,
      bookings,
      issue,
      routingContext,
      eventTypeId,
      organizationId: team.id,
      recipients: [owner.email, coHost.email, invitee.email].sort(),
    }
  }

  function snapshot(id: string) {
    return db
      .selectFrom('booking_routing')
      .selectAll()
      .where('booking_id', '=', id)
      .executeTakeFirst()
  }

  function receipt(token: string) {
    return db
      .selectFrom('routing_receipts')
      .selectAll()
      .where('token_hash', '=', routingTokenDigest(routingSecret, 'continuation', token))
      .executeTakeFirstOrThrow()
  }

  function recordedLocks() {
    return statements.filter((statement) =>
      /pg_advisory_xact_lock| for (?:share|update|key share|no key update)/.test(statement),
    )
  }

  function assertInvitation(
    messages: MailMessage[],
    recipients: string[],
    {
      booking,
      root,
      method,
      subject,
    }: { booking: Booking; root: string; method: string; subject: string },
  ) {
    expect(messages.map(({ to }) => to).sort()).toEqual(recipients)
    for (const message of messages)
      expect(message.subject).toContain(`${subject}: Collective appointment`)
    const calendar = messages.find(({ to }) => to === booking.attendees[0]?.email)?.attachments?.[0]
    expect(calendar?.contentType).toBe(`text/calendar; method=${method}; charset=UTF-8`)
    const lines = calendar?.content.split('\r\n')
    expect(lines).toContain(`METHOD:${method}`)
    expect(lines).toContain(`UID:${root}@hourmere`)
    expect(lines).toContain(`SEQUENCE:${method === 'REQUEST' ? 1 : 2}`)
    expect(lines).toContain(`DTSTART:${booking.start.replace(/[-:]|\.\d{3}/g, '')}`)
    expect(lines).toContain(`DTEND:${booking.end.replace(/[-:]|\.\d{3}/g, '')}`)
  }

  async function capture(organizationId: string) {
    await db
      .insertInto('webhooks')
      .values({
        organization_id: organizationId,
        url: 'https://webhook.example.test/',
        secret_ciphertext: Buffer.from('synthetic subscription'),
        events: ['booking.created', 'booking.rescheduled', 'booking.cancelled'],
      })
      .execute()
    const queue: { job: string; payload: unknown }[] = []
    const enqueue = async (job: string, payload: unknown) => {
      queue.push({ job, payload })
      return null
    }
    const emails = bookingNotifier({ enqueue })
    const calendars = calendarBookingNotifier({ enqueue })
    const webhooks = webhookBookingNotifier({ enqueue }, { enabled: true })
    const notify: BookingNotifier = async (trx, change, instant) => {
      await emails(trx, change, instant)
      if (change.type === 'created' || change.type === 'rescheduled' || change.type === 'cancelled')
        await calendars(trx, change)
      await webhooks(trx, change, instant)
    }
    async function sent(booking: Booking, kind: 'confirmed' | 'rescheduled' | 'cancelled') {
      const messages: MailMessage[] = []
      await sendBookingNotification(
        {
          db,
          now,
          secret: routingSecret,
          publicUrl: 'https://hourmere.example.test',
          mailer: {
            senderEmail: 'calendar@example.test',
            send: async (msg) => {
              messages.push(msg)
            },
          },
        },
        booking.id,
        kind,
      )
      return messages
    }
    async function webhook(booking: Booking, event: string, eventTypeId: string) {
      const row = await db
        .selectFrom('webhook_deliveries')
        .select(['event_id', 'payload'])
        .where('booking_id', '=', booking.id)
        .where('event_type', '=', event)
        .executeTakeFirstOrThrow()
      expect(JSON.parse(row.payload)).toEqual({
        id: row.event_id,
        type: event,
        occurredAt: now().toString(),
        data: {
          bookingId: booking.id,
          organizationId,
          eventTypeId,
          start: new Date(booking.start).toISOString(),
          end: new Date(booking.end).toISOString(),
          status: booking.status,
          source: booking.source,
          rescheduledFromId: booking.rescheduledFromId,
        },
      })
    }
    return { notify, queue, sent, webhook }
  }

  it.each(['invitee', 'host'] as const)(
    'preserves ordinary %s reschedule and cancellation SQL counts, locks and payloads',
    async (actor) => {
      const f = await fixture()
      const captureOutput = await capture(f.organizationId)
      const ctx = { db: observed, now, notify: captureOutput.notify }
      const author = { ...f.author, ...ctx }
      const original = await createPublicTeamBooking(ctx, f.bookings)
      if (!original.manageToken) throw new Error('Expected manage token')
      const next = { start: start().add({ hours: 24 }) }

      statements.length = 0
      const moved =
        actor === 'host'
          ? await rescheduleHostBooking(author, original.booking.id, next)
          : await rescheduleManagedBooking(ctx, original.manageToken, next)
      expect(moved.booking).toMatchObject({
        status: 'confirmed',
        start: next.start.toString({ fractionalSecondDigits: 3 }),
        responses,
        rescheduledFromId: original.booking.id,
      })
      const moveCount = statements.length
      const moveLocks = recordedLocks()
      assertInvitation(await captureOutput.sent(moved.booking, 'rescheduled'), f.recipients, {
        booking: moved.booking,
        root: original.booking.id,
        method: 'REQUEST',
        subject: 'Rescheduled',
      })
      expect(statements.join('\n')).not.toMatch(
        /"(?:booking_routing|routing_receipts|routing_forms)"/,
      )

      statements.length = 0
      const cancelled =
        actor === 'host'
          ? await cancelHostBooking(author, moved.booking.id, { reason: 'Plans changed' })
          : await cancelManagedBooking(ctx, moved.manageToken ?? original.manageToken, {
              reason: 'Plans changed',
            })
      expect(cancelled).toEqual({
        ...moved.booking,
        status: 'cancelled',
        cancelledAt: new Date(now().epochMilliseconds).toISOString(),
        cancelReason: 'Plans changed',
      })
      const cancelCount = statements.length
      const cancelLocks = recordedLocks()
      assertInvitation(await captureOutput.sent(cancelled, 'cancelled'), f.recipients, {
        booking: cancelled,
        root: original.booking.id,
        method: 'CANCEL',
        subject: 'Cancelled',
      })
      expect(statements.join('\n')).not.toMatch(
        /"(?:booking_routing|routing_receipts|routing_forms)"/,
      )

      await captureOutput.webhook(moved.booking, 'booking.rescheduled', f.eventTypeId)
      await captureOutput.webhook(cancelled, 'booking.cancelled', f.eventTypeId)
      expect(captureOutput.queue.filter(({ job }) => job === 'booking-notification')).toEqual([
        {
          job: 'booking-notification',
          payload: { bookingId: original.booking.id, kind: 'confirmed' },
        },
        {
          job: 'booking-notification',
          payload: { bookingId: moved.booking.id, kind: 'rescheduled' },
        },
        {
          job: 'booking-notification',
          payload: { bookingId: moved.booking.id, kind: 'reminder' },
        },
        {
          job: 'booking-notification',
          payload: { bookingId: moved.booking.id, kind: 'cancelled' },
        },
      ])

      expect(captureOutput.queue.filter(({ job }) => job === 'booking-calendar')).toEqual(
        Array.from({ length: 3 }, () => ({
          job: 'booking-calendar',
          payload: { bookingId: original.booking.id },
        })),
      )

      const query = (part: string) => expect.stringContaining(part)
      expect(moveCount).toBe(actor === 'host' ? 62 : 67)
      expect(cancelCount).toBe(actor === 'host' ? 33 : 37)
      expect(moveLocks).toEqual([
        query('from "auth"."organization" where "id" = $1 for share'),
        query(
          actor === 'host' ? 'as "booking_host"' : 'from "bookings" where "id" = $1 for update',
        ),
        query('pg_advisory_xact_lock'),
        query('pg_advisory_xact_lock'),
        query('from "auth"."user"'),
        query('from "auth"."member"'),
        query('from "event_types"'),
        query('for key share of "c"'),
        query('from "webhooks"'),
      ])
      expect(cancelLocks).toEqual([
        query('from "auth"."organization" where "id" = $1 for key share'),
        query(
          actor === 'host' ? 'for update of "b"' : 'from "bookings" where "id" = $1 for update',
        ),
        query('from "webhooks"'),
      ])
    },
  )

  it('leaves the snapshot and consumed receipt in place when the host cancels', async () => {
    const f = await fixture()
    const { input } = await f.issue()
    const creation = createRoutedBooking(f.routingContext, input)
    await expect(creation).resolves.toMatchObject({ booking: { status: 'confirmed' } })
    const { booking } = await creation
    const original = await snapshot(booking.id)
    expect(original?.answers).toEqual(expect.any(Object))
    const consumed = await receipt(input.routeToken)
    await expect(cancelHostBooking(f.author, booking.id)).resolves.toMatchObject({
      status: 'cancelled',
    })
    expect(await snapshot(booking.id)).toEqual(original)
    expect(await receipt(input.routeToken)).toEqual(consumed)
  })

  it('copies snapshots on host and invitee moves while off and keeps them on cancellation', async () => {
    const f = await fixture()
    const captureOutput = await capture(f.organizationId)
    const issued = await f.issue()
    const { input } = issued
    const ctx = { ...f.routingContext, notify: captureOutput.notify }
    const original = await createRoutedBooking(ctx, input)
    if (!original.manageToken) throw new Error('Expected manage token')
    const originalSnapshot = await snapshot(original.booking.id)
    expect(originalSnapshot).toMatchObject({
      booking_id: original.booking.id,
      form_id: issued.enabled.id,
      version_id: issued.version.id,
      answers: expect.objectContaining({ [issued.version.questions[0]?.id ?? '']: privateAnswer }),
      replay_fingerprint: expect.any(Buffer),
    })
    const consumed = await receipt(input.routeToken)
    expect(consumed).toMatchObject({
      consumed_booking_id: original.booking.id,
      answers_ciphertext: null,
    })
    await archiveRoutingForm(f.author, issued.enabled.id, {
      expectedRevision: issued.enabled.draftRevision,
    })
    const off = { ...ctx, routingFormsEnabled: false }
    const host = { ...f.author, ...off }
    const outsider = await createTestUser(db)
    await expect(
      rescheduleHostBooking(testContext(db, outsider.principal, now), original.booking.id, {
        start: start().add({ hours: 24 }),
      }),
    ).rejects.toMatchObject({ code: 'booking_not_found' })

    const initialMail = await captureOutput.sent(original.booking, 'confirmed')
    const first = await rescheduleHostBooking(host, original.booking.id, {
      start: start().add({ hours: 24 }),
    })
    expect(first.manageToken).toBeNull()
    expect((await getManagedBooking(off, original.manageToken)).id).toBe(first.booking.id)
    const firstMail = await captureOutput.sent(first.booking, 'rescheduled')
    const second = await rescheduleManagedBooking(off, original.manageToken, {
      start: start().add({ hours: 48 }),
    })
    if (!second.manageToken) throw new Error('Expected successor manage token')
    const secondMail = await captureOutput.sent(second.booking, 'rescheduled')
    const cancelled = await cancelManagedBooking(off, second.manageToken)
    const cancelledMail = await captureOutput.sent(cancelled, 'cancelled')
    expect(cancelled.status).toBe('cancelled')

    for (const booking of [first.booking, second.booking]) {
      expect(await snapshot(booking.id)).toEqual({
        ...originalSnapshot,
        booking_id: booking.id,
        replay_fingerprint: null,
      })
      expect(
        (
          await db
            .selectFrom('booking_hosts')
            .select('user_id')
            .where('booking_id', '=', booking.id)
            .orderBy('user_id')
            .execute()
        ).map(({ user_id }) => user_id),
      ).toEqual(f.hosts)
      expect(booking.responses).toEqual(responses)
      expect(JSON.stringify(booking)).not.toContain(privateAnswer)
      await captureOutput.webhook(booking, 'booking.rescheduled', f.eventTypeId)
    }
    expect(await snapshot(original.booking.id)).toEqual(originalSnapshot)
    expect(await receipt(input.routeToken)).toEqual(consumed)
    await expect(createRoutedBooking(off, input)).resolves.toMatchObject({
      replayed: true,
      booking: { id: original.booking.id },
      manageToken: null,
    })
    await expect(
      createRoutedBooking(ctx, { ...input, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'routing_unavailable' })
    await captureOutput.webhook(original.booking, 'booking.created', f.eventTypeId)
    await captureOutput.webhook(cancelled, 'booking.cancelled', f.eventTypeId)
    for (const messages of [initialMail, firstMail, secondMail, cancelledMail]) {
      expect(messages).toHaveLength(3)
      expect(
        messages
          .flatMap((message) => message.attachments ?? [])
          .some((attachment) => attachment.content.includes(`UID:${original.booking.id}`)),
      ).toBe(true)
      for (const privateValue of [
        privateAnswer,
        'Private routing label',
        input.routeToken,
        issued.enabled.id,
      ])
        expect(JSON.stringify(messages)).not.toContain(privateValue)
    }
    expect(captureOutput.queue.filter(({ job }) => job === 'booking-calendar')).toEqual([
      ...Array.from({ length: 4 }, () => ({
        job: 'booking-calendar',
        payload: { bookingId: original.booking.id },
      })),
    ])
  })
})
