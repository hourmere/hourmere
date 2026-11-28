import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createLogMailer, departureHandoffEmail, type Mailer } from '@hourmere/mail'
import { departureHandoffRecipientHash } from '@hourmere/scheduling/departure-handoff-delivery'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createDepartureHandoffEmailQueue,
  DEPARTURE_HANDOFF_EMAIL_JOB,
  deliverDepartureHandoffEmail,
  departureHandoffEmailJob,
} from './departure-handoff.ts'
import { notificationRecipientHash } from './mail-limits.ts'

const serverUrl = process.env.DATABASE_URL
const issuedAt = '2032-05-04T09:00:00.123456Z'
const start = '2032-05-04T12:00:00.123456Z'
const now = () => Temporal.Instant.from('2032-05-04T10:00:00Z')
const mailBudgetKey = 'synthetic-mail-budget-fixture'
const publicUrl = 'https://hourmere.example.test'

it('renders a private link in the fragment and explains unanimous consent in both languages', () => {
  const recipientId = randomUUID()
  const secret = 'N'.repeat(43)
  for (const [locale, requiresAll, privacy] of [
    ['en', 'the booker and every guest', 'keep this link private'],
    ['zh-CN', '预约人及每位来宾都同意', '请妥善保管此链接'],
  ] as const) {
    const mail = departureHandoffEmail({
      to: 'booker@example.test',
      publicUrl,
      recipientId,
      secret,
      locale,
    })
    const url = new URL(mail.text.match(/https:\/\/\S+/)?.[0] as string)
    expect(url.origin).toBe(publicUrl)
    expect(url.pathname).toBe('/booking-handoffs/offer')
    expect(url.search).toBe('')
    expect(url.hash).toBe(`#token=${recipientId}.${secret}`)
    expect(mail).toMatchObject({ to: 'booker@example.test', sensitive: true })
    expect(mail.text.toLowerCase()).toContain(requiresAll)
    expect(mail.text.toLowerCase()).toContain(privacy)
    expect(mail.html).toContain(`href="${url.href}"`)
    expect(mail.attachments).toBeUndefined()
  }
})

it('adds a transactional job with just the saved recipient ID', async () => {
  const recipientId = randomUUID()
  const jobId = randomUUID()
  const trx = {} as Db
  const enqueue = vi.fn(async () => jobId)
  await expect(createDepartureHandoffEmailQueue({ enqueue })(trx, recipientId)).resolves.toBe(jobId)
  expect(enqueue).toHaveBeenCalledExactlyOnceWith(
    DEPARTURE_HANDOFF_EMAIL_JOB,
    { recipientId },
    { transaction: trx },
  )
  const schema = departureHandoffEmailJob().payload
  expect(schema.safeParse({ recipientId }).success).toBe(true)
  expect(schema.safeParse({ recipientId, token: 'extra' }).success).toBe(false)
  expect(schema.safeParse({ recipientId, email: 'booker@example.test' }).success).toBe(false)
})

async function seed(db: Db) {
  const organizationId = randomUUID()
  const bookingId = randomUUID()
  const hostId = randomUUID()
  const offerId = randomUUID()
  const recipientId = randomUUID()
  const jobId = randomUUID()
  const email = `booker-${recipientId}@example.test`
  const previousDigest = randomBytes(32).toString('hex')
  await db
    .insertInto('auth.organization')
    .values({ id: organizationId, name: 'Handoff team', slug: organizationId, createdAt: issuedAt })
    .execute()
  await db
    .insertInto('bookings')
    .values({
      id: bookingId,
      organization_id: organizationId,
      source: 'web',
      status: 'confirmed',
      title: 'Private booking title',
      start_at: start,
      end_at: '2032-05-04T12:30:00.123456Z',
      required_host_user_ids: [hostId],
    })
    .execute()
  await db
    .insertInto('booking_attendees')
    .values({
      booking_id: bookingId,
      email: email.toUpperCase(),
      is_booker: true,
      locale: 'zh-CN',
      name: 'Private booker name',
      time_zone: 'UTC',
    })
    .execute()
  await db
    .insertInto('departure_handoff_offers')
    .values({
      id: offerId,
      organization_id: organizationId,
      source_booking_id: bookingId,
      version: 1,
      proposer_user_id: hostId,
      departing_user_id: hostId,
      target_start_at: start,
      duration_minutes: 30,
      terms_digest: 'a'.repeat(64),
      issued_at: issuedAt,
      expires_at: start,
    })
    .execute()
  await db
    .insertInto('departure_handoff_recipients')
    .values({
      id: recipientId,
      organization_id: organizationId,
      source_booking_id: bookingId,
      offer_id: offerId,
      offer_version: 1,
      recipient_key: email,
      token_digest: previousDigest,
    })
    .execute()
  await db
    .insertInto('departure_handoff_deliveries')
    .values({ job_id: jobId, recipient_id: recipientId })
    .execute()
  const read = () =>
    db
      .selectFrom('departure_handoff_deliveries as delivery')
      .innerJoin(
        'departure_handoff_recipients as recipient',
        'recipient.id',
        'delivery.recipient_id',
      )
      .innerJoin('bookings as source', 'source.id', 'recipient.source_booking_id')
      .select(['delivery.state', 'recipient.token_digest', 'source.status'])
      .where('delivery.job_id', '=', jobId)
      .executeTakeFirstOrThrow()
  return { email, organizationId, bookingId, recipientId, jobId, previousDigest, read }
}

describe.skipIf(!serverUrl)('PostgreSQL handoff delivery outcomes', () => {
  let fixtures: TestDatabase
  let db: Db
  beforeAll(async () => {
    fixtures = await createTestDatabase(serverUrl as string, undefined, { tag: 'handoff_mail' })
    db = createDb(fixtures.pool)
  })
  afterAll(async () => {
    await fixtures?.drop()
  })

  it.each([
    ['rejected', 'failed'],
    ['known_not_sent', 'failed'],
    ['delivery_unknown', 'unknown'],
  ] as const)('handles %s after a durable attempt', async (outcome, state) => {
    const { email, bookingId, recipientId, jobId, previousDigest, read } = await seed(db)
    const exchange = vi.fn<NonNullable<Mailer['sendWorkflowAttempt']>>(async () => outcome)
    const send = vi.fn()
    const deps = {
      db,
      mailer: { send, sendWorkflowAttempt: exchange },
      publicUrl,
      secret: mailBudgetKey,
      now,
    }
    await deliverDepartureHandoffEmail(deps, { recipientId }, { id: jobId })
    expect(exchange).toHaveBeenCalledTimes(1)
    const message = exchange.mock.calls[0]?.[0]
    expect(message?.to).toBe(email.toUpperCase())
    expect(message?.sensitive).toBe(true)
    expect(message?.subject).toBe('查看预约变更提议')
    expect(send).not.toHaveBeenCalled()
    const saved = await read()
    expect(saved).toMatchObject({ state, status: 'confirmed' })
    if (state === 'failed') expect(saved.token_digest).toBeNull()
    else {
      expect(saved.token_digest).toMatch(/^[a-f0-9]{64}$/)
      expect(saved.token_digest).not.toBe(previousDigest)
    }
    expect(
      await db
        .selectFrom('departure_handoff_send_budgets')
        .select('counted_sends')
        .where('source_booking_id', '=', bookingId)
        .executeTakeFirst(),
    ).toEqual({ counted_sends: 1 })
    await deliverDepartureHandoffEmail(deps, { recipientId }, { id: jobId })
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(await read()).toEqual(saved)
  })

  it('marks a queued fourth delivery unavailable without sending or retrying', async () => {
    const { email, organizationId, bookingId, recipientId, jobId, previousDigest, read } =
      await seed(db)
    await db
      .insertInto('departure_handoff_send_budgets')
      .values({
        organization_id: organizationId,
        source_booking_id: bookingId,
        recipient_hash: departureHandoffRecipientHash(bookingId, email),
        counted_sends: 3,
      })
      .execute()
    expect(await read()).toMatchObject({ state: 'queued' })

    const send = vi.fn()
    const exchange = vi.fn<NonNullable<Mailer['sendWorkflowAttempt']>>(async () => 'sent')
    const deps = {
      db,
      mailer: { send, sendWorkflowAttempt: exchange },
      publicUrl,
      secret: mailBudgetKey,
      now,
    }
    const deliver = () => deliverDepartureHandoffEmail(deps, { recipientId }, { id: jobId })

    await expect(deliver()).resolves.toBeUndefined()
    const saved = await read()
    expect(saved).toEqual({
      state: 'unavailable',
      token_digest: previousDigest,
      status: 'confirmed',
    })

    await expect(deliver()).resolves.toBeUndefined()
    expect(await read()).toEqual(saved)
    expect(exchange).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(
      await db
        .selectFrom('departure_handoff_send_budgets')
        .select('counted_sends')
        .where('source_booking_id', '=', bookingId)
        .executeTakeFirst(),
    ).toEqual({ counted_sends: 3 })
  })

  it('keeps the last digest when a send is unavailable or suppressed by shared mail limits', async () => {
    const print = vi.fn()
    const log = await seed(db)
    const common = { db, publicUrl, secret: mailBudgetKey, now }
    await deliverDepartureHandoffEmail(
      { ...common, mailer: createLogMailer(print) },
      { recipientId: log.recipientId },
      { id: log.jobId },
    )
    const saturated = await seed(db)
    await db
      .insertInto('notification_email_sends')
      .values({
        recipient_hash: notificationRecipientHash(saturated.email, mailBudgetKey),
        sent_at: new Date(now().epochMilliseconds),
      })
      .execute()
    const exchange = vi.fn()
    const send = vi.fn()
    await deliverDepartureHandoffEmail(
      { ...common, mailer: { send, sendWorkflowAttempt: exchange }, mailRecipientMaxPerHour: 1 },
      { recipientId: saturated.recipientId },
      { id: saturated.jobId },
    )
    expect(print).not.toHaveBeenCalled()
    expect(exchange).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    for (const fixture of [log, saturated]) {
      expect(await fixture.read()).toEqual({
        state: 'unavailable',
        token_digest: fixture.previousDigest,
        status: 'confirmed',
      })
      expect(
        await db
          .selectFrom('departure_handoff_send_budgets')
          .select('counted_sends')
          .where('source_booking_id', '=', fixture.bookingId)
          .executeTakeFirst(),
      ).toBeUndefined()
    }
  })
})
