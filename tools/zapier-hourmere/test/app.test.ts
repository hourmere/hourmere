import { createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import nock from 'nock'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const App = require(process.env.HOURMERE_ZAPIER_TEST_APP ?? '../index.js')
const { createAppTester } = require('zapier-platform-core')
const appTester = createAppTester(App)
const baseUrl = 'https://hourmere.example.test'
const authData = { baseUrl, apiKey: 'hm_synthetic_test_only' }
const id = '00000000-0000-4000-8000-000000000001'
const nextId = '00000000-0000-4000-8000-000000000002'
const secret = 'whsec_synthetic_unit_test_only'
const booking = {
  id,
  eventTypeId: nextId,
  status: 'confirmed',
  start: '2027-03-14T09:30:00Z',
  end: '2027-03-14T10:00:00Z',
  title: 'Synthetic appointment',
  location: null,
  responses: {},
  attendees: [],
  rescheduledFromId: null,
  rescheduledToId: null,
  cancelledAt: null,
  cancelReason: null,
  source: 'api',
  createdAt: '2027-01-01T00:00:00Z',
}
const api = () => nock(baseUrl, { reqheaders: { authorization: `Bearer ${authData.apiKey}` } })
const run = (fn: unknown, inputData = {}, extra = {}) =>
  appTester(fn, { authData, inputData, ...extra })

beforeAll(() => {
  if (!nock.isActive()) nock.activate()
  nock.disableNetConnect()
})
afterEach(() => {
  const pending = nock.pendingMocks()
  nock.cleanAll()
  expect(pending).toEqual([])
})
afterAll(() => {
  nock.cleanAll()
  nock.enableNetConnect()
  // Permitting requests alone leaves Nock's global HTTP interception installed.
  nock.restore()
  expect(nock.isActive()).toBe(false)
})

describe('Hourmere Zapier authentication and reads', () => {
  it('tests even an empty account with an authenticated cheap read', async () => {
    api()
      .get('/api/v1/me')
      .reply(200, { user: { id, name: 'Example' } })
    await expect(run(App.authentication.test)).resolves.toBeDefined()
    expect(App.authentication.type).toBe('custom')
    expect(
      App.authentication.fields.find((field: { key: string }) => field.key === 'apiKey').type,
    ).toBe('password')
    expect(
      App.authentication.fields.find((field: { key: string }) => field.key === 'baseUrl').required,
    ).toBe(true)
  })

  it.each([
    'http://hourmere.example.test',
    'https://user:synthetic@hourmere.example.test',
    'https://hourmere.example.test/api',
    'https://hourmere.example.test?key=synthetic',
    'https://hourmere.example.test#fragment',
    'not a URL',
  ])('rejects unsafe instance origin %s before sending credentials', async (url) => {
    await expect(
      run(App.authentication.test, {}, { authData: { ...authData, baseUrl: url } }),
    ).rejects.toThrow('invalid_base_url')
  })
  it('lists event types for the dynamic dropdown', async () => {
    const events = [{ id: nextId, slug: 'consultation', title: 'Consultation' }]
    api().get('/api/v1/event-types').reply(200, { data: events })
    await expect(run(App.triggers.event_types.operation.perform)).resolves.toEqual(events)
  })
  it('finds a hosted booking by ID', async () => {
    api().get(`/api/v1/bookings/${id}`).reply(200, booking)
    await expect(run(App.searches.find_booking.operation.perform, { id })).resolves.toEqual([
      booking,
    ])
  })
  it('returns no search results only for booking_not_found', async () => {
    api().get(`/api/v1/bookings/${id}`).reply(404, { error: 'booking_not_found' })
    await expect(run(App.searches.find_booking.operation.perform, { id })).resolves.toEqual([])
  })
  it.each(['personal', 'team'])('finds %s slots without altering DST instants', async (kind) => {
    const prefix = kind === 'team' ? '/api/v1/public/teams' : '/api/v1/public'
    api()
      .get(`${prefix}/synthetic/consultation/slots`)
      .query({
        start: '2027-03-14T00:00:00-08:00',
        end: '2027-03-15T00:00:00-07:00',
        durationMinutes: 30,
      })
      .reply(200, { data: [{ start: booking.start, end: booking.end }] })
    await expect(
      run(App.searches.find_available_slots.operation.perform, {
        kind,
        handle: 'synthetic',
        slug: 'consultation',
        start: '2027-03-14T00:00:00-08:00',
        end: '2027-03-15T00:00:00-07:00',
        durationMinutes: 30,
      }),
    ).resolves.toEqual([{ id: booking.start, start: booking.start, end: booking.end }])
  })
})

describe('Hourmere Zapier writes', () => {
  it.each(['personal', 'team'])(
    'creates a %s booking and preserves the retry key',
    async (kind) => {
      const prefix = kind === 'team' ? '/api/v1/public/teams' : '/api/v1/public'
      const input = {
        kind,
        handle: 'synthetic',
        slug: 'consultation',
        start: booking.start,
        name: 'Example',
        email: 'example@example.test',
        timeZone: 'America/Los_Angeles',
        locale: 'zh-CN',
        durationMinutes: 30,
        idempotencyKey: 'synthetic-stable-upstream-operation-id',
        responses: '{"question":"Answer"}',
      }
      api()
        .post(`${prefix}/synthetic/consultation/bookings`, {
          start: booking.start,
          durationMinutes: 30,
          invitee: {
            name: input.name,
            email: input.email,
            timeZone: input.timeZone,
            locale: input.locale,
          },
          responses: { question: 'Answer' },
        })
        .matchHeader('idempotency-key', input.idempotencyKey)
        .twice()
        .reply(201, {
          booking,
          manageToken: 'synthetic-private-capability',
          successRedirect: { url: 'https://example.test/private' },
        })
      const first = await run(App.creates.create_booking.operation.perform, input)
      const replay = await run(App.creates.create_booking.operation.perform, input)
      expect(first).toEqual(booking)
      expect(replay).toEqual(first)
      expect(JSON.stringify(first).includes('synthetic-private-capability')).toBe(false)
    },
  )

  it.each([undefined, '', 'contains\nnewline', '非ASCII', 'x'.repeat(256)])(
    'rejects absent or invalid retry key %#',
    async (idempotencyKey) => {
      await expect(
        run(App.creates.create_booking.operation.perform, { idempotencyKey }),
      ).rejects.toThrow('invalid_idempotency_key')
    },
  )
  it('keeps concurrent creation keys separate and omits optional inputs', async () => {
    const inputs = ['first', 'second'].map((suffix) => ({
      kind: 'personal',
      handle: 'synthetic',
      slug: 'consultation',
      start: booking.start,
      name: 'Example',
      email: 'example@example.test',
      timeZone: 'UTC',
      idempotencyKey: `synthetic-${suffix}`,
    }))
    for (const input of inputs) {
      api()
        .post('/api/v1/public/synthetic/consultation/bookings', {
          start: booking.start,
          invitee: { name: input.name, email: input.email, timeZone: 'UTC' },
        })
        .matchHeader('idempotency-key', input.idempotencyKey)
        .reply(201, { booking: { ...booking, id: input.idempotencyKey }, manageToken: null })
    }
    const results = await Promise.all(
      inputs.map((input) => run(App.creates.create_booking.operation.perform, input)),
    )
    expect(results.map((result) => result.id)).toEqual(inputs.map((input) => input.idempotencyKey))
  })

  it.each(['create', 'reschedule', 'slots'])(
    'passes invalid zero duration through for server validation: %s',
    async (action) => {
      const input = {
        kind: 'personal',
        handle: 'synthetic',
        slug: 'consultation',
        id,
        name: 'Example',
        email: 'example@example.test',
        timeZone: 'UTC',
        start: booking.start,
        end: booking.end,
        durationMinutes: 0,
        idempotencyKey: 'synthetic-zero-duration',
      }
      if (action === 'create') {
        api()
          .post('/api/v1/public/synthetic/consultation/bookings', {
            start: input.start,
            durationMinutes: 0,
            invitee: { name: input.name, email: input.email, timeZone: input.timeZone },
          })
          .reply(400, { error: 'invalid_request' })
      } else if (action === 'reschedule') {
        api()
          .post(`/api/v1/bookings/${id}/reschedule`, { start: input.start, durationMinutes: 0 })
          .reply(400, { error: 'invalid_request' })
      } else {
        api()
          .get('/api/v1/public/synthetic/consultation/slots')
          .query({ start: input.start, end: input.end, durationMinutes: 0 })
          .reply(400, { error: 'invalid_request' })
      }
      const perform =
        action === 'create'
          ? App.creates.create_booking.operation.perform
          : action === 'reschedule'
            ? App.creates.reschedule_booking.operation.perform
            : App.searches.find_available_slots.operation.perform
      await expect(run(perform, input)).rejects.toThrow('invalid_request')
    },
  )
  it('cancels the specified booking with a reason', async () => {
    api()
      .post(`/api/v1/bookings/${id}/cancel`, { reason: 'Plans changed' })
      .reply(200, { ...booking, status: 'cancelled' })
    await expect(
      run(App.creates.cancel_booking.operation.perform, { id, reason: 'Plans changed' }),
    ).resolves.toMatchObject({ id, status: 'cancelled' })
  })
  it('reschedules with the selected duration and returns the successor without capability fields', async () => {
    const moved = {
      ...booking,
      id: nextId,
      rescheduledFromId: id,
      start: '2027-11-07T01:30:00-08:00',
    }
    api()
      .post(`/api/v1/bookings/${id}/reschedule`, { start: moved.start, durationMinutes: 60 })
      .reply(200, { booking: moved, manageToken: 'synthetic-private-capability' })
    await expect(
      run(App.creates.reschedule_booking.operation.perform, {
        id,
        start: moved.start,
        durationMinutes: 60,
      }),
    ).resolves.toEqual(moved)
  })
  it.each(['[]', 'null', '42', '"text"'])(
    'rejects non-object question answers %s',
    async (responses) => {
      await expect(
        run(App.creates.create_booking.operation.perform, {
          idempotencyKey: 'synthetic-stable-key',
          responses,
        }),
      ).rejects.toThrow('invalid_responses')
    },
  )
  it('refuses malformed response JSON before making a request', async () => {
    await expect(
      run(App.creates.create_booking.operation.perform, {
        idempotencyKey: 'synthetic-stable-key',
        responses: '{invalid',
      }),
    ).rejects.toThrow('invalid_responses')
  })
})

function delivery(type = 'booking.created', offsetSeconds = 0) {
  const event = {
    id: nextId,
    type,
    occurredAt: new Date().toISOString(),
    data: {
      bookingId: id,
      organizationId: nextId,
      eventTypeId: nextId,
      start: booking.start,
      end: booking.end,
      status: type === 'booking.cancelled' ? 'cancelled' : 'confirmed',
      source: 'api',
      rescheduledFromId: type === 'booking.rescheduled' ? id : null,
    },
  }
  // Whitespace exercises exact raw bytes, not reserialized cleanedRequest.
  const content = JSON.stringify(event, null, 2)
  const timestamp = String(Math.floor(Date.now() / 1000) + offsetSeconds)
  const signature = `v1=${createHmac('sha256', secret).update(`${timestamp}.${content}`).digest('hex')}`
  return {
    event,
    bundle: {
      subscribeData: { id, secret },
      cleanedRequest: event,
      rawRequest: {
        content,
        headers: { 'Http-Webhook-Timestamp': timestamp, 'Http-Webhook-Signature': signature },
      },
    },
  }
}

describe('Hourmere REST hooks', () => {
  it.each(['created', 'cancelled', 'rescheduled'])(
    'subscribes, accepts, samples and unsubscribes booking.%s',
    async (suffix) => {
      const operation = App.triggers[`booking_${suffix}`].operation
      const targetUrl = 'https://hooks.example.test/synthetic'
      api()
        .post('/api/v1/webhooks', { url: targetUrl, events: [`booking.${suffix}`] })
        .reply(201, { webhook: { id }, secret })
      await expect(run(operation.performSubscribe, {}, { targetUrl })).resolves.toEqual({
        id,
        secret,
      })
      const hook = delivery(`booking.${suffix}`)
      const received = await run(operation.perform, {}, hook.bundle)
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({ id: nextId })
      expect(operation.outputFields.map((field: { key: string }) => field.key)).toEqual(
        expect.arrayContaining(Object.keys(received[0])),
      )
      expect(Object.keys(operation.sample).sort()).toEqual(Object.keys(received[0]).sort())
      const sampleBooking = {
        ...booking,
        status: suffix === 'cancelled' ? 'cancelled' : 'confirmed',
        rescheduledFromId: suffix === 'rescheduled' ? nextId : null,
      }
      api()
        .get('/api/v1/bookings')
        .query(true)
        .reply(200, { data: [sampleBooking], nextCursor: null })
      const sample = await run(operation.performList)
      expect(sample).toHaveLength(1)
      api().delete(`/api/v1/webhooks/${id}`).reply(204)
      await expect(
        run(operation.performUnsubscribe, {}, { subscribeData: { id, secret } }),
      ).resolves.toBeDefined()
    },
  )

  it.each(['created', 'cancelled', 'rescheduled'])(
    'filters lifecycle samples for %s',
    async (suffix) => {
      const original = { ...booking }
      const moved = { ...booking, id: nextId, rescheduledFromId: id }
      const old = { ...booking, status: 'cancelled', rescheduledToId: nextId }
      const cancelled = {
        ...booking,
        id: 'cancelled-booking',
        status: 'cancelled',
        cancelledAt: booking.end,
      }
      const data = suffix === 'cancelled' ? [old, cancelled] : [original, moved]
      api()
        .get('/api/v1/bookings')
        .query({
          limit: 25,
          order: 'desc',
          ...(suffix === 'cancelled' ? { status: 'cancelled' } : {}),
        })
        .reply(200, { data, nextCursor: null })
      const result = await run(App.triggers[`booking_${suffix}`].operation.performList)
      expect(result).toHaveLength(1)
      expect(result[0].bookingId).toBe(
        suffix === 'created' ? id : suffix === 'rescheduled' ? nextId : cancelled.id,
      )
      expect(result[0].organizationId).toBeNull()
    },
  )
  it('returns stable signed IDs on accepted retries for downstream idempotency', async () => {
    const hook = delivery()
    const perform = App.triggers.booking_created.operation.perform
    const first = await run(perform, {}, hook.bundle)
    const replay = await run(perform, {}, hook.bundle)
    expect(first[0].id).toBe(nextId)
    expect(replay[0].id).toBe(first[0].id)
  })
  it.each([
    'tampered',
    'wrong secret',
    'missing secret',
    'stale',
    'future',
    'missing signature',
    'missing raw body',
    'wrong event',
  ])('rejects %s deliveries', async (failure) => {
    const hook = delivery(
      failure === 'wrong event' ? 'booking.cancelled' : 'booking.created',
      failure === 'stale' ? -301 : failure === 'future' ? 301 : 0,
    )
    if (failure === 'tampered') hook.bundle.rawRequest.content += ' '
    if (failure === 'missing secret') hook.bundle.subscribeData.secret = ''
    if (failure === 'wrong secret') hook.bundle.subscribeData.secret = 'wrong-synthetic-secret'
    if (failure === 'missing signature')
      hook.bundle.rawRequest.headers['Http-Webhook-Signature'] = ''
    if (failure === 'missing raw body') hook.bundle.rawRequest.content = ''
    await expect(
      run(App.triggers.booking_created.operation.perform, {}, hook.bundle),
    ).rejects.toThrow()
  })
  it('uses signed raw JSON rather than a substituted cleanedRequest', async () => {
    const hook = delivery()
    hook.bundle.cleanedRequest = { ...hook.event, id }
    const result = await run(App.triggers.booking_created.operation.perform, {}, hook.bundle)
    expect(result[0].id).toBe(nextId)
  })
})

describe('Hourmere API errors', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'insufficient_scope'],
    [409, 'slot_taken'],
    [404, 'event_type_not_found'],
    [500, 'internal_error'],
  ])('preserves error code for HTTP %s', async (status, error) => {
    api().get('/api/v1/me').reply(Number(status), { error })
    await expect(run(App.authentication.test)).rejects.toThrow(String(error))
  })
  it('does not hide unrelated 404 errors as an empty search result', async () => {
    api().get(`/api/v1/bookings/${id}`).reply(404, { error: 'route_not_found' })
    await expect(run(App.searches.find_booking.operation.perform, { id })).rejects.toThrow(
      'route_not_found',
    )
  })
  it('honors Retry-After seconds using Zapier throttling', async () => {
    api().get('/api/v1/me').reply(429, { error: 'rate_limited' }, { 'Retry-After': '47' })
    await expect(run(App.authentication.test)).rejects.toMatchObject({
      name: 'ThrottledError',
      message: expect.stringContaining('"delay":47'),
    })
  })
  it('honors HTTP-date Retry-After', async () => {
    api()
      .get('/api/v1/me')
      .reply(
        429,
        { error: 'rate_limited' },
        { 'Retry-After': new Date(Date.now() + 120_000).toUTCString() },
      )
    try {
      await run(App.authentication.test)
      throw new Error('Expected throttling')
    } catch (error) {
      expect(error).toMatchObject({ name: 'ThrottledError' })
      const { delay } = JSON.parse((error as Error).message) as { delay: number }
      expect(typeof delay).toBe('number')
      expect(delay).toBeGreaterThanOrEqual(118)
      expect(delay).toBeLessThanOrEqual(120)
    }
  })
})
