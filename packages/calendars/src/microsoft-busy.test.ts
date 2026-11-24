import { describe, expect, it, vi } from 'vitest'
import { createMicrosoftCalendarClient, MicrosoftDeltaReset } from './microsoft.ts'

const config = {
  clientId: 'fake-client',
  clientSecret: 'fake-secret',
  publicUrl: 'http://localhost:5173',
}
const calendarId = 'AAMkExample='
const graph = 'https://graph.microsoft.com'
const deltaEndpoint = `${graph}/v1.0/me/calendars/${calendarId}/calendarView/delta`
const nextLink = `${deltaEndpoint}?$skiptoken=A%2BB%3D`
const deltaLink = `${deltaEndpoint}?$deltatoken=R0usmcFuQtZdtpk4%3D`
const instant = (value: string) => Temporal.Instant.from(value)
const start = instant('2026-03-07T00:00:00Z')
const end = instant('2026-03-10T00:00:00Z')

// The event fields are the calendarView delta projection from Microsoft Learn.
const utc = (dateTime: string) => ({ dateTime, timeZone: 'UTC' })
const event = {
  '@odata.type': '#microsoft.graph.event',
  id: 'AAMkEvent=',
  type: 'singleInstance',
  start: utc('2026-03-07T12:00:00.1234567'),
  end: utc('2026-03-07T13:00:00.0000000'),
  showAs: 'busy',
  isCancelled: false,
  isAllDay: false,
}
const graphError = (code: string, status: number, headers?: Record<string, string>) =>
  Response.json(
    { error: { code, message: 'private provider text', innerError: { 'request-id': 'opaque' } } },
    { status, headers },
  )
const finish = (value: unknown[] = []) => Response.json({ '@odata.deltaLink': deltaLink, value })
const read = (request: typeof fetch, link?: string, signal = new AbortController().signal) =>
  createMicrosoftCalendarClient(config, request).deltaEvents(
    'fake-access',
    calendarId,
    { start, end, link },
    signal,
  )

describe('Microsoft Graph calendarView delta', () => {
  it('uses the opaque continuation and delta URLs and sends the same UTC preference each time', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ '@odata.nextLink': nextLink, value: [] }))
      .mockResolvedValueOnce(finish())
      .mockResolvedValueOnce(finish())

    expect(await read(request)).toEqual({ nextLink, changes: [] })
    expect(await read(request, nextLink)).toEqual({ deltaLink, changes: [] })
    expect(await read(request, deltaLink)).toEqual({ deltaLink, changes: [] })
    expect(request).toHaveBeenCalledTimes(3)
    const first = new URL(String(request.mock.calls[0]?.[0]))
    expect(first.origin).toBe(graph)
    expect(first.pathname).toBe(
      `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta`,
    )
    expect(first.searchParams.get('startDateTime')).toBe(start.toString())
    expect(first.searchParams.get('endDateTime')).toBe(end.toString())
    expect(first.searchParams.has('$select')).toBe(false)
    expect(request.mock.calls[1]?.[0]).toBe(nextLink)
    expect(request.mock.calls[2]?.[0]).toBe(deltaLink)
    for (const [, init] of request.mock.calls) {
      expect(init?.redirect).toBe('error')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer fake-access')
      expect(headers.get('prefer')).toBe('outlook.timezone="UTC", odata.maxpagesize=50')
    }
  })

  it('preserves expanded recurring, cancelled, and all-day changes while dropping event content', async () => {
    const recurring = {
      ...event,
      seriesMasterId: 'AAMkSeries=',
      originalStart: '2026-03-07T12:00:00.0000000Z',
    }
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      finish([
        { ...event, subject: 'Private meeting', attendees: [{ emailAddress: 'private' }] },
        { ...event, id: 'free', showAs: 'free' },
        { ...event, id: 'elsewhere', showAs: 'workingElsewhere' },
        { ...recurring, id: 'cancelled', type: 'occurrence', isCancelled: true },
        { ...recurring, id: 'tentative', type: 'occurrence', showAs: 'tentative' },
        {
          ...recurring,
          id: 'moved',
          type: 'exception',
          showAs: 'unknown',
          start: utc('2026-03-08T14:30:00.0000000'),
          end: utc('2026-03-08T15:30:00.0000000'),
        },
        { ...event, id: 'AAMkSeries=', type: 'seriesMaster' },
        {
          '@odata.type': '#microsoft.graph.event',
          id: 'removed',
          '@removed': { reason: 'deleted' },
        },
        {
          ...event,
          id: 'all-day',
          isAllDay: true,
          showAs: 'oof',
          // Pacific local midnight to midnight across the spring DST transition.
          start: utc('2026-03-08T08:00:00.0000000'),
          end: utc('2026-03-09T07:00:00.0000000'),
        },
      ]),
    )

    const single = {
      kind: 'event',
      type: 'singleInstance',
      seriesMasterId: null,
      originalStart: null,
      cancelled: false,
    }
    const occurrence = {
      ...single,
      type: 'occurrence',
      seriesMasterId: recurring.seriesMasterId,
      originalStart: '2026-03-07T12:00:00Z',
    }
    const period = {
      start: instant('2026-03-07T12:00:00.1234567Z'),
      end: instant('2026-03-07T13:00:00Z'),
    }
    expect(await read(request)).toEqual({
      deltaLink,
      changes: [
        { ...single, id: event.id, period },
        { ...single, id: 'free', period: null },
        { ...single, id: 'elsewhere', period: null },
        { ...occurrence, id: 'cancelled', cancelled: true, period: null },
        { ...occurrence, id: 'tentative', period },
        {
          ...occurrence,
          id: 'moved',
          type: 'exception',
          period: {
            start: instant('2026-03-08T14:30:00Z'),
            end: instant('2026-03-08T15:30:00Z'),
          },
        },
        { ...single, id: 'AAMkSeries=', type: 'seriesMaster', period: null },
        { kind: 'removed', id: 'removed' },
        {
          ...single,
          id: 'all-day',
          period: {
            start: instant('2026-03-08T08:00:00Z'),
            end: instant('2026-03-09T07:00:00Z'),
          },
        },
      ],
    })
  })

  it.each([
    ['expired access', () => graphError('InvalidAuthenticationToken', 401), 'needs_reauth'],
    ['missing permission', () => graphError('ErrorAccessDenied', 403), 'permissions_missing'],
    ['unavailable', () => graphError('ServiceUnavailable', 503), 'provider_unavailable'],
    ['malformed JSON', () => new Response('{"value":'), 'provider_unavailable'],
    ['missing value', () => Response.json({ error: { code: 'unknown' } }), 'provider_unavailable'],
    [
      'invalid date',
      () => finish([{ ...event, start: utc('2026-02-30T00:00:00') }]),
      'provider_unavailable',
    ],
    [
      'unrequested response zone',
      () => finish([{ ...event, start: { ...event.start, timeZone: 'Pacific Standard Time' } }]),
      'provider_unavailable',
    ],
    [
      'missing original occurrence identity',
      () => finish([{ ...event, type: 'exception', seriesMasterId: 'AAMkSeries=' }]),
      'provider_unavailable',
    ],
    [
      'missing delta and continuation links',
      () => Response.json({ value: [event] }),
      'provider_unavailable',
    ],
  ])('rejects a delta page with %s', async (_label, response, code) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response())
    const error = await read(request, nextLink).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ name: 'MicrosoftCalendarError', code, message: code })
    expect((error as Error).cause).toBeUndefined()
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([
    () => new Response(null, { status: 410, headers: { Location: 'https://example.invalid' } }),
    () => graphError('syncStateNotFound', 404),
    () =>
      Response.json(
        { error: { code: 'BadRequest', innerError: { code: 'SyncStateNotFound' } } },
        { status: 400 },
      ),
  ])('signals an expired cursor without following or exposing the reset URL', async (response) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response())
    const error = await read(request, deltaLink).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(MicrosoftDeltaReset)
    expect(String(error)).not.toMatch(/example\.invalid|private provider text/)
    expect(request).toHaveBeenCalledOnce()
  })

  it('retries a throttled page once after the advertised delay', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(graphError('TooManyRequests', 429, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(finish([event]))
    const opened = performance.now()
    expect((await read(request, nextLink)).changes).toHaveLength(1)
    expect(performance.now() - opened).toBeGreaterThanOrEqual(900)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0]?.[0]).toBe(nextLink)
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0])
  })

  it.each([
    ['120', 1],
    ['not a valid delay', 1],
    ['0', 2],
  ])('bounds unsuccessful retries for Retry-After %s', async (retryAfter, calls) => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        graphError('TooManyRequests', 429, { 'Retry-After': retryAfter }),
      )
    await expect(read(request)).rejects.toMatchObject({ code: 'provider_unavailable', status: 429 })
    expect(request).toHaveBeenCalledTimes(calls)
  })

  it('bounds an unresponsive request with the calendarView deadline', async () => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal)
    try {
      const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
      const pending = read(request)
      expect(timeout).toHaveBeenCalledWith(15_000)
      expect(request).toHaveBeenCalledOnce()
      deadline.abort('private timeout reason')
      await expect(pending).rejects.toMatchObject({
        code: 'provider_unavailable',
        message: 'provider_unavailable',
      })
      expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    } finally {
      timeout.mockRestore()
    }
  })

  it('cancels a stalled continuation response body on caller abort', async () => {
    const controller = new AbortController()
    const reading = Promise.withResolvers<void>()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>(
      { pull: () => reading.resolve(), cancel },
      { highWaterMark: 0 },
    )
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body))
    const pending = read(request, nextLink, controller.signal)
    await reading.promise
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it.each([
    nextLink.replace(graph, 'https://example.invalid'),
    nextLink.replace(calendarId, 'different-calendar'),
    nextLink.replace(calendarId, '%invalid'),
    nextLink.replace('calendarView', 'events'),
  ])(
    'rejects an out-of-bound continuation before sending Graph credentials to %s',
    async (link) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ '@odata.nextLink': link, value: [event] }))
      await expect(read(request)).rejects.toMatchObject({ code: 'provider_unavailable' })
      expect(request).toHaveBeenCalledOnce()
      request.mockClear()
      await expect(read(request, link)).rejects.toMatchObject({ code: 'provider_unavailable' })
      expect(request).not.toHaveBeenCalled()
    },
  )

  it('rejects a continuation that points to the same page', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ '@odata.nextLink': nextLink, value: [] }))
    await expect(read(request, nextLink)).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(request).toHaveBeenCalledOnce()
  })
})
