import { describe, expect, it, vi } from 'vitest'
import { createMicrosoftCalendarClient } from './microsoft.ts'

const config = {
  clientId: 'fake-client',
  clientSecret: 'fake-secret',
  publicUrl: 'http://localhost:5173',
}
const calendarId = 'AAMkExample='
const graph = 'https://graph.microsoft.com'
const nextLink = `${graph}/v1.0/me/calendars/${calendarId}/calendarView?$skiptoken=A%2BB%3D`
const instant = (value: string) => Temporal.Instant.from(value)
const start = instant('2026-03-07T00:00:00Z')
const end = instant('2026-03-10T00:00:00Z')

// Graph event/dateTimeTimeZone projection used by the v1.0 calendarView endpoint.
const utc = (dateTime: string) => ({ dateTime, timeZone: 'UTC' })
const event = {
  id: 'AAMkEvent=',
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
const read = (request: typeof fetch, signal = new AbortController().signal) =>
  createMicrosoftCalendarClient(config, request).busyEvents(
    'fake-access',
    calendarId,
    start,
    end,
    signal,
  )

describe('Microsoft Graph calendarView busy times', () => {
  it('follows opaque nextLinks with the same UTC preference and returns only blocking intervals', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          '@odata.context': `${graph}/v1.0/$metadata#Collection(event)`,
          '@odata.nextLink': nextLink,
          value: [
            { ...event, subject: 'Private meeting', attendees: [{ emailAddress: 'private' }] },
            { ...event, id: 'free', showAs: 'free' },
            { ...event, id: 'elsewhere', showAs: 'workingElsewhere' },
            { ...event, id: 'cancelled', isCancelled: true },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          value: [
            {
              ...event,
              id: 'all-day',
              isAllDay: true,
              showAs: 'oof',
              // Pacific local midnight to midnight across the spring DST transition.
              start: utc('2026-03-08T08:00:00.0000000'),
              end: utc('2026-03-09T07:00:00.0000000'),
            },
            { ...event, id: 'tentative', showAs: 'tentative', type: 'occurrence' },
            { ...event, id: 'unknown', showAs: 'unknown', type: 'exception' },
          ],
        }),
      )

    expect(await read(request)).toEqual([
      {
        id: event.id,
        start: instant('2026-03-07T12:00:00.1234567Z'),
        end: instant('2026-03-07T13:00:00Z'),
      },
      {
        id: 'all-day',
        start: instant('2026-03-08T08:00:00Z'),
        end: instant('2026-03-09T07:00:00Z'),
      },
      {
        id: 'tentative',
        start: instant('2026-03-07T12:00:00.1234567Z'),
        end: instant('2026-03-07T13:00:00Z'),
      },
      {
        id: 'unknown',
        start: instant('2026-03-07T12:00:00.1234567Z'),
        end: instant('2026-03-07T13:00:00Z'),
      },
    ])
    expect(request).toHaveBeenCalledTimes(2)
    const first = new URL(String(request.mock.calls[0]?.[0]))
    expect(first.origin).toBe(graph)
    expect(first.pathname).toBe(`/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView`)
    expect(first.searchParams.get('startDateTime')).toBe(start.toString())
    expect(first.searchParams.get('endDateTime')).toBe(end.toString())
    expect(first.searchParams.get('$select')).toBe('id,start,end,isAllDay,isCancelled,showAs')
    expect(request.mock.calls[1]?.[0]).toBe(nextLink)
    for (const [, init] of request.mock.calls) {
      expect(init?.redirect).toBe('error')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer fake-access')
      expect(headers.get('prefer')).toBe('outlook.timezone="UTC"')
    }
  })

  it.each([
    ['expired access', () => graphError('InvalidAuthenticationToken', 401), 'needs_reauth'],
    ['missing permission', () => graphError('ErrorAccessDenied', 403), 'permissions_missing'],
    ['unavailable', () => graphError('ServiceUnavailable', 503), 'provider_unavailable'],
    ['malformed JSON', () => new Response('{"value":'), 'provider_unavailable'],
    ['missing value', () => Response.json({ error: { code: 'unknown' } }), 'provider_unavailable'],
    [
      'invalid date',
      () => Response.json({ value: [{ ...event, start: utc('2026-02-30T00:00:00') }] }),
      'provider_unavailable',
    ],
    [
      'unrequested response zone',
      () =>
        Response.json({
          value: [{ ...event, start: { ...event.start, timeZone: 'Pacific Standard Time' } }],
        }),
      'provider_unavailable',
    ],
  ])('discards an otherwise valid first page after %s', async (_label, second, code) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ '@odata.nextLink': nextLink, value: [event] }))
      .mockResolvedValueOnce(second())
    const error = await read(request).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ name: 'MicrosoftCalendarError', code, message: code })
    expect((error as Error).cause).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('retries a throttled page once after the advertised delay', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ '@odata.nextLink': nextLink, value: [] }))
      .mockResolvedValueOnce(graphError('TooManyRequests', 429, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(Response.json({ value: [event] }))
    const opened = performance.now()
    expect(await read(request)).toHaveLength(1)
    expect(performance.now() - opened).toBeGreaterThanOrEqual(900)
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[1]?.[0]).toBe(nextLink)
    expect(request.mock.calls[2]).toEqual(request.mock.calls[1])
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

  it('discards earlier pages when the caller aborts a stalled response body', async () => {
    const controller = new AbortController()
    const reading = Promise.withResolvers<void>()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>(
      { pull: () => reading.resolve(), cancel },
      { highWaterMark: 0 },
    )
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ '@odata.nextLink': nextLink, value: [event] }))
      .mockResolvedValueOnce(new Response(body))
    const pending = read(request, controller.signal)
    await reading.promise
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(request.mock.calls[1]?.[1]?.signal?.aborted).toBe(true)
  })

  it.each([
    nextLink.replace(graph, 'https://example.invalid'),
    nextLink.replace(calendarId, 'different-calendar'),
    nextLink.replace(calendarId, '%invalid'),
    nextLink.replace('calendarView', 'events'),
  ])('rejects an out-of-bound nextLink before making a request to %s', async (link) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ '@odata.nextLink': link, value: [event] }))
    await expect(read(request)).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(request).toHaveBeenCalledOnce()
  })

  it('rejects cyclic paging without returning the first page', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ '@odata.nextLink': nextLink, value: [event] }))
      .mockResolvedValueOnce(Response.json({ '@odata.nextLink': nextLink, value: [] }))
    await expect(read(request)).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(request).toHaveBeenCalledTimes(2)
  })
})
