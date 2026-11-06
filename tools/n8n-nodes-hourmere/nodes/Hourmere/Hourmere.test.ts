import type { ICredentialTestFunctions, IExecuteFunctions } from 'n8n-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HourmereApi } from '../../credentials/HourmereApi.credentials'
import { baseUrl, hourmereRequest, testHourmereCredential } from '../../shared/http'
import { Hourmere } from './Hourmere.node'

function fixture(params: Record<string, unknown> = {}, response: unknown = { id: 'result' }) {
  const http = vi.fn().mockResolvedValue({ statusCode: 200, headers: {}, body: response })
  const context = {
    getCredentials: vi
      .fn()
      .mockResolvedValue({ baseUrl: 'https://hourmere.example/', apiKey: 'test-private-key' }),
    getNode: () => ({
      name: 'Hourmere',
      type: 'hourmere',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    }),
    getInputData: () => [{ json: {} }],
    getNodeParameter: (name: string, _index: number, fallback: unknown) => params[name] ?? fallback,
    continueOnFail: () => false,
    helpers: { httpRequestWithAuthentication: http },
  } as unknown as IExecuteFunctions
  return { context, http, execute: () => new Hourmere().execute.call(context) }
}
afterEach(() => vi.useRealTimers())
describe('Hourmere actions', () => {
  it.each([
    ['listEventTypes', 'GET', '/event-types', {}],
    ['getBooking', 'GET', '/bookings/booking', { bookingId: 'booking' }],
    [
      'listBookings',
      'GET',
      '/bookings',
      {
        filters: {
          status: 'cancelled',
          from: '2026-11-01T00:00:00Z',
          cursor: 'next',
          limit: 10,
          order: 'desc',
        },
      },
    ],
    [
      'cancelBooking',
      'POST',
      '/bookings/booking/cancel',
      { bookingId: 'booking', reason: 'Changed plans' },
    ],
    [
      'rescheduleBooking',
      'POST',
      '/bookings/booking/reschedule',
      {
        bookingId: 'booking',
        start: '2026-11-01T01:30:00-08:00',
        additionalFields: { durationMinutes: 60 },
      },
    ],
  ])('%s maps the existing REST operation', async (operation, method, path, params) => {
    const f = fixture(
      { operation, ...params },
      operation.startsWith('list')
        ? { data: [{ id: 'result' }], nextCursor: null }
        : { id: 'result' },
    )
    const result = await f.execute()
    expect(f.http).toHaveBeenCalledWith(
      'hourmereApi',
      expect.objectContaining({
        method,
        url: `https://hourmere.example/api/v1${path}`,
        disableFollowRedirect: true,
      }),
    )
    expect(result).toEqual([[{ json: { id: 'result' }, pairedItem: { item: 0 } }]])
    if (operation === 'listBookings') expect(f.http.mock.calls[0]![1].qs).toEqual(params.filters)
    if (operation === 'cancelBooking')
      expect(f.http.mock.calls[0]![1].body).toEqual({ reason: 'Changed plans' })
    if (operation === 'rescheduleBooking')
      expect(f.http.mock.calls[0]![1].body).toEqual({
        start: '2026-11-01T01:30:00-08:00',
        durationMinutes: 60,
      })
  })
  it('returns all booking pages as paired items and preserves filters', async () => {
    const f = fixture({
      operation: 'listBookings',
      returnAll: true,
      filters: { status: 'confirmed' },
    })
    f.http
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { data: [{ id: 'one' }], nextCursor: 'next' },
      })
      .mockResolvedValueOnce({ statusCode: 200, body: { data: [{ id: 'two' }], nextCursor: null } })
    expect(await f.execute()).toEqual([
      [
        { json: { id: 'one' }, pairedItem: { item: 0 } },
        { json: { id: 'two' }, pairedItem: { item: 0 } },
      ],
    ])
    expect(f.http.mock.calls[1]![1].qs).toEqual({ status: 'confirmed', limit: 100, cursor: 'next' })
  })
  it('limits across booking pages and stops requesting at the limit', async () => {
    const f = fixture({ operation: 'listBookings', returnAll: false, limit: 101 })
    f.http
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { data: Array.from({ length: 100 }, (_, id) => ({ id })), nextCursor: 'next' },
      })
      .mockResolvedValueOnce({ statusCode: 200, body: { data: [{ id: 100 }], nextCursor: 'more' } })
    expect((await f.execute())[0]).toHaveLength(101)
    expect(f.http).toHaveBeenCalledTimes(2)
    expect(f.http.mock.calls[1]![1].qs).toEqual({ limit: 1, cursor: 'next' })
  })
  it('limits event types and emits empty lists without placeholder items', async () => {
    const f = fixture(
      { operation: 'listEventTypes', limit: 1 },
      { data: [{ id: 'one' }, { id: 'two' }] },
    )
    expect((await f.execute())[0]).toEqual([{ json: { id: 'one' }, pairedItem: { item: 0 } }])
    expect(
      await fixture({ operation: 'listBookings' }, { data: [], nextCursor: null }).execute(),
    ).toEqual([[]])
  })
  it('preserves source pairing for multiple input items', async () => {
    const f = fixture(
      { operation: 'listEventTypes', returnAll: true },
      { data: [{ id: 'one' }, { id: 'two' }] },
    )
    f.context.getInputData = () => [{ json: {} }, { json: {} }]
    expect((await f.execute())[0]?.map((item) => item.pairedItem)).toEqual([
      { item: 0 },
      { item: 0 },
      { item: 1 },
      { item: 1 },
    ])
  })
  it('rejects repeated cursors and bounds unique cursor pages', async () => {
    const f = fixture(
      { operation: 'listBookings', returnAll: true },
      { data: [], nextCursor: 'same' },
    )
    await expect(f.execute()).rejects.toThrow('pagination exceeded')
    expect(f.http).toHaveBeenCalledTimes(2)
    let cursor = 0
    f.http.mockClear().mockImplementation(async () => ({
      statusCode: 200,
      body: { data: [], nextCursor: String(++cursor) },
    }))
    await expect(f.execute()).rejects.toThrow('pagination exceeded')
    expect(f.http).toHaveBeenCalledTimes(1000)
  })
  it.each([0, -1, 1.5, 100001])(
    'rejects invalid list limit %s before network activity',
    async (limit) => {
      const f = fixture({ operation: 'listBookings', limit })
      await expect(f.execute()).rejects.toThrow('Limit must')
      expect(f.http).not.toHaveBeenCalled()
    },
  )
  it.each(['personal', 'team'])(
    'creates %s bookings with retained idempotency key and answers',
    async (pageType) => {
      const f = fixture({
        operation: 'createBooking',
        pageType,
        handle: 'owner',
        slug: 'meeting',
        start: '2026-11-01T09:30:00Z',
        name: 'Guest',
        email: 'guest@example.test',
        timeZone: 'America/Los_Angeles',
        idempotencyKey: 'stable-request',
        additionalFields: {
          responses: '{"question":"answer"}',
          guests: '[{"name":"Friend","email":"friend@example.test"}]',
        },
      })
      await f.execute()
      await f.execute()
      for (const call of f.http.mock.calls)
        expect(call[1]).toMatchObject({
          method: 'POST',
          url: `https://hourmere.example/api/v1/public${pageType === 'team' ? '/teams' : ''}/owner/meeting/bookings`,
          headers: { 'Idempotency-Key': 'stable-request' },
          body: {
            start: '2026-11-01T09:30:00Z',
            invitee: {
              name: 'Guest',
              email: 'guest@example.test',
              timeZone: 'America/Los_Angeles',
            },
            responses: { question: 'answer' },
            guests: [{ name: 'Friend', email: 'friend@example.test' }],
          },
        })
    },
  )
  it('requires a create idempotency key before network activity', async () => {
    const f = fixture({ operation: 'createBooking', timeZone: 'UTC' })
    await expect(f.execute()).rejects.toThrow('idempotency key')
    expect(f.http).not.toHaveBeenCalled()
  })
  it('preserves UTC instants and displays distinct DST offsets for repeated local times', async () => {
    const slots = [
      { start: '2026-11-01T08:30:00Z', end: '2026-11-01T09:00:00Z' },
      { start: '2026-11-01T09:30:00Z', end: '2026-11-01T10:00:00Z' },
    ]
    const f = fixture(
      {
        operation: 'findSlots',
        pageType: 'personal',
        handle: 'owner',
        slug: 'meeting',
        start: '2026-11-01T00:00:00-07:00',
        end: '2026-11-02T00:00:00-08:00',
        timeZone: 'America/Los_Angeles',
      },
      { data: slots },
    )
    const result = await f.execute()
    const data = result[0]![0]!.json.data as Record<string, string>[]
    expect(f.http.mock.calls[0]![1].qs).toEqual({
      start: '2026-11-01T00:00:00-07:00',
      end: '2026-11-02T00:00:00-08:00',
    })
    expect(data.map((s) => s.start)).toEqual(slots.map((s) => s.start))
    expect(data[0]!.localStart).not.toBe(data[1]!.localStart)
  })
  it('rejects invalid zones and escapes path segments', async () => {
    const bad = fixture({ operation: 'findSlots', timeZone: 'invalid' })
    await expect(bad.execute()).rejects.toThrow('IANA')
    expect(bad.http).not.toHaveBeenCalled()
    const f = fixture({ operation: 'getBooking', bookingId: '../secret?x=y' })
    await f.execute()
    expect(f.http.mock.calls[0]![1].url).toContain('/bookings/..%2Fsecret%3Fx%3Dy')
  })
})
describe('HTTP protections and credentials', () => {
  it('uses a password credential and a cheap authenticated read test', async () => {
    const c = new HourmereApi()
    expect(c.properties.find((p) => p.name === 'apiKey')?.typeOptions?.password).toBe(true)
    expect(c.authenticate.properties.headers?.Authorization).toBe('=Bearer {{$credentials.apiKey}}')
    expect(new Hourmere().description.credentials?.[0]?.testedBy).toBe('testHourmereCredential')
    expect(new Hourmere().methods.credentialTest.testHourmereCredential).toBe(
      testHourmereCredential,
    )
    const request = vi.fn().mockResolvedValue({ statusCode: 200 })
    const context = { helpers: { request } } as unknown as ICredentialTestFunctions
    for (const url of ['https://hourmere.example', 'https://hourmere.example/']) {
      await expect(
        testHourmereCredential.call(context, {
          id: 'test',
          name: 'test',
          data: { baseUrl: url, apiKey: 'test-private-key' },
        }),
      ).resolves.toMatchObject({ status: 'OK' })
      expect(request).toHaveBeenLastCalledWith(
        expect.objectContaining({
          uri: 'https://hourmere.example/api/v1/profile',
          method: 'GET',
          followRedirect: false,
          followAllRedirects: false,
          rejectUnauthorized: true,
          headers: { Authorization: 'Bearer test-private-key' },
        }),
      )
    }
    request.mockResolvedValue({ statusCode: 302 })
    await expect(
      testHourmereCredential.call(context, {
        id: 'test',
        name: 'test',
        data: { baseUrl: 'https://hourmere.example' },
      }),
    ).resolves.toMatchObject({ status: 'Error' })
  })
  it.each([
    'file:///private',
    'https://user:pass@example.test',
    'https://example.test?key=private',
    'https://example.test/#fragment',
    'http://example.test',
    'http://localhost.example.test',
    'http://192.168.1.1',
  ])(
    'rejects unsafe base URL %s in execution and credential test before network activity',
    async (url) => {
      expect(() => baseUrl(url)).toThrow()
      const f = fixture({ operation: 'getBooking' })
      vi.mocked(f.context.getCredentials).mockResolvedValue({ baseUrl: url })
      await expect(f.execute()).rejects.toThrow()
      expect(f.http).not.toHaveBeenCalled()
      const request = vi.fn()
      await expect(
        testHourmereCredential.call(
          { helpers: { request } } as unknown as ICredentialTestFunctions,
          { id: 'test', name: 'test', data: { baseUrl: url } },
        ),
      ).resolves.toMatchObject({ status: 'Error' })
      expect(request).not.toHaveBeenCalled()
    },
  )
  it.each([
    'http://localhost:4000',
    'http://127.0.0.1:4000',
    'http://[::1]:4000',
    'https://example.test',
  ])('allows safe base URL %s', (url) => {
    expect(baseUrl(url)).toBe(url)
  })
  it('redacts driver details and arbitrary server bodies while retaining API codes', async () => {
    const f = fixture()
    f.http.mockRejectedValueOnce(new Error('test-private-key invitee@example.test'))
    await expect(hourmereRequest.call(f.context, 'GET', '/profile')).rejects.toThrow(
      'network_error',
    )
    f.http.mockResolvedValueOnce({
      statusCode: 403,
      headers: {},
      body: { error: 'insufficient_scope', message: 'test-private-key' },
    })
    try {
      await hourmereRequest.call(f.context, 'GET', '/profile')
      expect.fail('must reject')
    } catch (e) {
      expect(String(e)).toContain('insufficient_scope')
      expect(String(e)).not.toContain('test-private-key')
    }
  })
  it('waits Retry-After before one retry and stops on repeated throttling', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.http.mockResolvedValue({
      statusCode: 429,
      headers: { 'retry-after': '2' },
      body: { error: 'rate_limited' },
    })
    const promise = hourmereRequest.call(f.context, 'GET', '/profile')
    const assertion = expect(promise).rejects.toThrow('Retry after 2 seconds')
    await vi.advanceTimersByTimeAsync(1999)
    expect(f.http).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await assertion
    expect(f.http).toHaveBeenCalledTimes(2)
  })
  it('does not retry transport failures, redirects, or long Retry-After', async () => {
    for (const response of [
      { statusCode: 302, headers: { location: 'https://elsewhere.test' }, body: {} },
      { statusCode: 429, headers: { 'retry-after': '120' }, body: { error: 'rate_limited' } },
    ]) {
      const f = fixture()
      f.http.mockResolvedValue(response)
      await expect(hourmereRequest.call(f.context, 'POST', '/bookings/id/cancel')).rejects.toThrow()
      expect(f.http).toHaveBeenCalledTimes(1)
    }
  })
})
