import { createHash, randomBytes } from 'node:crypto'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { createApp } from '../app.ts'
import { bookingRoutes, ManagedBooking } from './bookings.ts'
import { openApiDocument, productApp, resolve } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T12:00:00Z')
const path = '/api/v1/bookings/manage'
const start = '2026-11-04T09:00:00.000Z'
const end = '2026-11-04T09:30:00.000Z'
const requestToken = () => randomBytes(32).toString('base64url')
const hash = (token: string) => createHash('sha256').update(token).digest()
const notFound = '{"error":"booking_not_found","message":"No such booking"}'
const formId = '3a2e0460-0a5d-44fb-8b41-62f2b616259b'
const versionId = 'b3fb485e-894f-4be6-aca5-9af4d583608e'
const matchedRuleId = 'fb8cb964-b053-438c-956b-4a1d5124a54e'
const resolvedRuleId = '1791b64d-2dc5-4f36-9f8f-7d6aa5080e25'
const selectId = '415bd292-8c4e-09a8-088f-367017c5399a'
const textId = 'f08ee2a4-7855-4fdc-b61e-dd04a8988665'
const optionalId = 'db85cf21-4875-4db0-880e-127dd3a0a2cf'
const optionId = 'c71e5848-c074-0ef8-0f29-d46433ab9585'
const unusedOptionId = '89bf5ecb-1a49-4e88-89a8-31813f6b9a7d'
const privateText = '<b>Original answer</b> & "quoted"'
const otherAnswer = 'Answer from a different booking'
const savedAnswers = [
  { label: 'Original <category>', answer: 'Product & support' },
  { label: 'Original topic', answer: privateText },
]

describe.skipIf(!serverUrl)('invitee routing answers over REST', () => {
  let owned: TestDatabase
  let db: Db
  let observed: Db
  let app: ReturnType<typeof createApp>
  let host: Awaited<ReturnType<typeof createTestUser>>
  let eventTypeId: string
  let ordinary: Awaited<ReturnType<typeof booking>>
  let ordinaryEmail: string
  let cancelled: Awaited<ReturnType<typeof booking>>
  const statements: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'managed_routing' })
    db = createDb(owned.pool)
    observed = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
    host = await createTestUser(db, 'Host')
    const fixtures = createFixtures(db)
    await fixtures.schedule(host.id, { timeZone: 'UTC' })
    eventTypeId = await fixtures.eventType(host.principal.organization.id, host.id, {
      title: 'Consultation',
      questions: [{ id: 'topic', label: 'Booking topic', type: 'short_text', required: true }],
    })
    ordinary = await booking(host, { eventTypeId, start: '2026-11-04T10:00:00.000Z' })
    ordinaryEmail = await emailToken(ordinary.id)
    cancelled = await booking(host, { eventTypeId: null, status: 'cancelled', start })
    app = productApp(observed, new Map([['synthetic-host', host.principal]]), [
      bookingRoutes({ db: observed, now }),
    ])
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function booking(
    owner: typeof host,
    options: { eventTypeId: string | null; start: string; status?: 'confirmed' | 'cancelled' },
  ) {
    const organizationId = owner.principal.organization.id
    const end = Temporal.Instant.from(options.start).add({ minutes: 30 }).toString()
    const id = await createFixtures(db).booking(organizationId, [owner.id], options.start, end, {
      eventTypeId: options.eventTypeId,
      attendee: { name: 'Invitee', email: 'invitee@example.test' },
      ...(options.status && { status: options.status }),
    })
    const token = requestToken()
    await db
      .updateTable('bookings')
      .set({
        manage_token_hash: hash(token),
        title: 'Fixture booking',
        created_at: now().toString(),
        responses: JSON.stringify({ topic: 'Final booking answer' }),
        ...(options.status === 'cancelled' && { cancelled_at: now().toString() }),
      })
      .where('id', '=', id)
      .execute()
    return { id, token }
  }

  async function emailToken(id: string) {
    const token = requestToken()
    const attendee = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', id)
      .where('is_booker', '=', true)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_notifications')
      .values({
        booking_id: id,
        kind: 'confirmed',
        recipient: `attendee:${attendee.id}`,
        outcome: 'sent',
        manage_token_hash: hash(token),
      })
      .execute()
    return token
  }

  async function storeSnapshot(id: string, owner: typeof host, answer: string) {
    await db
      .insertInto('booking_routing')
      .values({
        booking_id: id,
        organization_id: owner.principal.organization.id,
        form_id: formId,
        version_id: versionId,
        version_number: 4,
        matched_rule_id: matchedRuleId,
        resolved_rule_id: resolvedRuleId,
        questions: JSON.stringify([
          {
            id: selectId,
            type: 'select',
            label: 'Original <category>',
            required: true,
            options: [
              { id: unusedOptionId, label: 'Unused choice' },
              { id: optionId, label: 'Product & support' },
            ],
          },
          { id: textId, type: 'short_text', label: 'Original topic', required: true },
          { id: optionalId, type: 'email', label: 'Unanswered question', required: false },
        ]),
        answers: JSON.stringify({ [selectId]: optionId, [textId]: answer }),
        replay_fingerprint: randomBytes(32),
      })
      .execute()
  }

  function get(token?: string, headers?: Record<string, string>, suffix = '') {
    return app.request(`${path}${suffix}`, {
      headers: { ...headers, ...(token !== undefined && { 'x-manage-token': token }) },
    })
  }

  async function read(token: string) {
    const response = await get(token)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as ReturnType<typeof ManagedBooking.parse>
    expect(ManagedBooking.safeParse(body).success).toBe(true)
    return body
  }

  it('preserves ordinary response bytes, statuses and statement counts', async () => {
    function body(hasEvent: boolean) {
      return JSON.stringify({
        id: hasEvent ? ordinary.id : cancelled.id,
        eventTypeId: hasEvent ? eventTypeId : null,
        status: hasEvent ? 'confirmed' : 'cancelled',
        start: hasEvent ? '2026-11-04T10:00:00.000Z' : start,
        end: hasEvent ? '2026-11-04T10:30:00.000Z' : end,
        title: 'Fixture booking',
        location: null,
        responses: { topic: 'Final booking answer' },
        attendees: [
          {
            name: 'Invitee',
            email: 'invitee@example.test',
            timeZone: 'UTC',
            locale: null,
            isBooker: true,
          },
        ],
        rescheduledFromId: null,
        cancelledAt: hasEvent ? null : '2026-11-01T12:00:00.000Z',
        cancelReason: null,
        source: 'api',
        createdAt: '2026-11-01T12:00:00.000Z',
        eventType: hasEvent ? { title: 'Consultation', durationMinutes: 30 } : null,
        hosts: [{ name: 'Host' }],
        changeDeadlines: { rescheduleBy: null, cancelBy: null },
      })
    }
    for (const [name, token, status, bytes, count] of [
      ['booking link', ordinary.token, 200, body(true), 12],
      ['email link', ordinaryEmail, 200, body(true), 13],
      ['cancelled booking without event', cancelled.token, 200, body(false), 11],
      ['unknown token', requestToken(), 404, notFound, 1],
      ['malformed token', 'malformed', 404, notFound, 0],
      ['missing token', undefined, 404, notFound, 0],
    ] as const) {
      statements.length = 0
      const response = await get(token)
      expect(response.status, name).toBe(status)
      expect(await response.text(), name).toBe(bytes)
      expect(statements, name).toHaveLength(count)
      expect(
        statements.some((sql) => sql.includes('"booking_routing"')),
        name,
      ).toBe(false)
    }

    const limited = productApp(observed, new Map(), [
      bookingRoutes({ db: observed, now, rateLimits: { manage: { limit: 1, windowSeconds: 60 } } }),
    ])
    const request = () => limited.request(path, { headers: { 'x-manage-token': ordinary.token } })
    expect((await request()).status).toBe(200)
    statements.length = 0
    const response = await request()
    expect(response.status).toBe(429)
    expect(await response.text()).toBe('{"error":"rate_limited"}')
    expect(statements).toHaveLength(0)
  })

  it('enforces the existing manage-token authority and projects only the matching answers', async () => {
    const routed = await booking(host, { eventTypeId, start })
    await storeSnapshot(routed.id, host, privateText)
    const other = await createTestUser(db, 'Other host')
    const foreign = await booking(other, { eventTypeId: null, start })
    await storeSnapshot(foreign.id, other, otherAnswer)

    const own = await read(routed.token)
    expect(own).toMatchObject({ id: routed.id, responses: { topic: 'Final booking answer' } })
    expect(own.routingAnswers).toEqual(savedAnswers)
    const foreignBody = await read(foreign.token)
    expect(foreignBody.id).toBe(foreign.id)
    expect(foreignBody.routingAnswers).toEqual([
      savedAnswers[0],
      { label: 'Original topic', answer: otherAnswer },
    ])
    for (const value of [
      'routing',
      'formId',
      'versionId',
      'versionNumber',
      'matchedRuleId',
      'resolvedRuleId',
      'diagnostics',
      'target',
    ]) {
      expect(own).not.toHaveProperty(value)
    }
    const bytes = JSON.stringify(own)
    for (const privateValue of [
      formId,
      versionId,
      matchedRuleId,
      resolvedRuleId,
      selectId,
      optionId,
      'Unused choice',
      'Unanswered question',
      otherAnswer,
    ]) {
      expect(bytes).not.toContain(privateValue)
    }

    for (const response of [
      await get(routed.id),
      await get(undefined, { authorization: 'Bearer synthetic-host' }),
      await get(undefined, undefined, `?token=${routed.token}&id=${routed.id}`),
    ]) {
      expect(response.status).toBe(404)
      expect(await response.text()).toBe(notFound)
    }
    const wrongHeader = await get(undefined, { authorization: `Bearer ${routed.token}` })
    expect(wrongHeader.status).toBe(401)
    expect(await wrongHeader.text()).toBe('{"error":"unauthorized"}')
  })

  it('keeps the original snapshot on the predecessor and successor of an invitee move', async () => {
    const routed = await booking(host, { eventTypeId, start: '2026-11-04T11:00:00.000Z' })
    await storeSnapshot(routed.id, host, privateText)
    const fromEmail = await emailToken(routed.id)
    const response = await app.request(`${path}/reschedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-manage-token': routed.token },
      body: JSON.stringify({ start: '2026-11-05T11:00:00.000Z' }),
    })
    expect(response.status).toBe(200)
    const moved = (await response.json()) as { booking: { id: string }; manageToken: string }
    expect(moved.booking).not.toHaveProperty('routingAnswers')
    expect(await read(routed.token)).toMatchObject({
      id: routed.id,
      status: 'cancelled',
      routingAnswers: savedAnswers,
    })
    for (const token of [moved.manageToken, fromEmail]) {
      expect(await read(token)).toMatchObject({
        id: moved.booking.id,
        status: 'confirmed',
        rescheduledFromId: routed.id,
        routingAnswers: savedAnswers,
      })
    }
  })
})

it('documents the optional answer-only projection on the manage response', async () => {
  const db = {} as Db
  const document = await openApiDocument(productApp(db, new Map(), [bookingRoutes({ db })]))
  const response = document.paths[path]?.get?.responses['200']?.content?.['application/json']
  expect(response?.schema).toEqual({ $ref: '#/components/schemas/ManagedBooking' })
  const schema = resolve(document, response?.schema ?? {})
  const parts = schema.allOf as Record<string, unknown>[]
  expect(parts[1]).toMatchObject({
    properties: {
      routingAnswers: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, answer: { type: 'string' } },
          required: ['label', 'answer'],
        },
      },
    },
  })
  expect(parts[1]?.required).not.toContain('routingAnswers')
  expect(document.components.schemas.Booking).not.toHaveProperty('properties.routingAnswers')
})
