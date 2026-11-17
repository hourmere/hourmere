import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import type { CalDavRequest, CalDavResponse } from './caldav-transport.ts'
import { createCalDavWriteClient } from './caldav-write-client.ts'

const credentials = {
  serverUrl: 'https://calendar.example.com/',
  username: 'owner@example.com',
  password: 'secret-app-password',
}
const body =
  'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:booking\r\nSUMMARY:Private title\r\nEND:VEVENT\r\nEND:VCALENDAR'
function fixture(responses: CalDavResponse[]) {
  const transport = vi.fn(async (_input: CalDavRequest) => {
    const response = responses.shift()
    if (!response) throw new Error('Unexpected request')
    return response
  })
  return { transport, client: createCalDavWriteClient(transport) }
}
const resource = {
  calendarUrl: `${credentials.serverUrl}cal/`,
  resourceUrl: `${credentials.serverUrl}cal/booking.ics`,
}
describe('conditional CalDAV write transport', () => {
  it.each([
    '/remote.php/dav/calendars/alice/personal/',
    '/123456789/calendars/2B50F064-0406-45C2-AD63/',
  ])('preserves resource identity and conditions for provider path %s', async (path) => {
    const input = {
      calendarUrl: `https://calendar.example.com${path}`,
      resourceUrl: `https://calendar.example.com${path}booking.ics`,
    }
    const { client, transport } = fixture([
      { status: 201, body: '', etag: '"one"' },
      { status: 200, body, etag: '"one"' },
      { status: 204, body: '', etag: '"two"' },
      { status: 204, body: '' },
    ])
    expect(await client.put(credentials, { ...input, body, etag: null })).toEqual({ etag: '"one"' })
    expect(await client.get(credentials, input)).toEqual({ etag: '"one"', body })
    expect(await client.put(credentials, { ...input, body, etag: '"one"' })).toEqual({
      etag: '"two"',
    })
    expect(await client.delete(credentials, { ...input, etag: '"two"' })).toBe('deleted')
    expect(
      transport.mock.calls.map(([call]) => [call.method, call.url, call.ifNoneMatch, call.ifMatch]),
    ).toEqual([
      ['PUT', input.resourceUrl, '*', undefined],
      ['GET', input.resourceUrl, undefined, undefined],
      ['PUT', input.resourceUrl, undefined, '"one"'],
      ['DELETE', input.resourceUrl, undefined, '"two"'],
    ])
    expect(transport.mock.calls[0]?.[0].body).toBe(body)
    expect(transport.mock.calls[0]?.[0].contentType).toBe('text/calendar; charset=utf-8')
  })
  it.each([404, 412])(
    'returns HTTP %s for reconciler without retrying or dropping conditions',
    async (status) => {
      const { client, transport } = fixture([
        { status, body: credentials.password },
        { status, body: credentials.password },
      ])
      expect(await client.put(credentials, { ...resource, body, etag: '"one"' })).toEqual(
        status === 404 ? { missing: true } : { conflict: true },
      )
      expect(await client.delete(credentials, { ...resource, etag: '"one"' })).toBe(
        status === 404 ? 'missing' : 'conflict',
      )
      expect(transport).toHaveBeenCalledTimes(2)
    },
  )
  it('returns missing read and missing successful PUT etag for explicit reconciliation', async () => {
    const { client } = fixture([
      { status: 404, body: '' },
      { status: 201, body: '' },
    ])
    expect(await client.get(credentials, resource)).toBeNull()
    expect(await client.put(credentials, { ...resource, body, etag: null })).toEqual({ etag: null })
  })
  it.each(['W/"weak"', '*', 'unquoted', '"header\r\ninjection"'])(
    'rejects unsafe etag %s before mutation',
    async (etag) => {
      const { client, transport } = fixture([])
      await expect(client.put(credentials, { ...resource, body, etag })).rejects.toMatchObject({
        code: 'invalid_response',
      })
      await expect(client.delete(credentials, { ...resource, etag })).rejects.toMatchObject({
        code: 'invalid_response',
      })
      expect(transport).not.toHaveBeenCalled()
    },
  )
  it.each([undefined, 'W/"weak"'])('does not accept a GET without a strong etag', async (etag) => {
    const { client } = fixture([{ status: 200, body, etag }])
    await expect(client.get(credentials, resource)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })
  it.each([
    'https://other.example.com/cal/booking.ics',
    'https://127.0.0.1/cal/booking.ics',
    'http://calendar.example.com/cal/booking.ics',
    'https://calendar.example.com/other/booking.ics',
    'https://calendar.example.com/cal/nested/booking.ics',
    'https://calendar.example.com/cal/%2f..%2fsecret.ics',
  ])('refuses foreign or unsafe resource %s before sending credentials', async (resourceUrl) => {
    const { client, transport } = fixture([])
    await expect(
      client.put(credentials, { ...resource, resourceUrl, body, etag: null }),
    ).rejects.toMatchObject({ code: 'destination_refused' })
    expect(transport).not.toHaveBeenCalled()
  })
  it('refuses redirects without forwarding credentials or replaying the write', async () => {
    const { client, transport } = fixture([
      { status: 307, body: '', location: 'https://other.example.com/cal/booking.ics' },
    ])
    await expect(client.put(credentials, { ...resource, body, etag: null })).rejects.toMatchObject({
      code: 'destination_refused',
    })
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [507, 'unavailable'],
  ] as const)('classifies HTTP %s without provider body leakage', async (status, code) => {
    const { client, transport } = fixture([{ status, body: credentials.password }])
    await expect(client.put(credentials, { ...resource, body, etag: null })).rejects.toMatchObject({
      code,
      message: `CalDAV ${code}`,
    })
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('redacts both credentials and ICS from logs and discards provider exception details', async () => {
    const transport = vi.fn(async (_request: CalDavRequest): Promise<CalDavResponse> => {
      throw new Error(credentials.password)
    })
    const error = await createCalDavWriteClient(transport)
      .put(credentials, { ...resource, body, etag: null })
      .catch((error: unknown) => error)
    expect(error).toMatchObject({ message: 'CalDAV transport_failed' })
    expect(error).not.toHaveProperty('cause')
    const request = transport.mock.calls[0]?.[0]
    expect(request).toBeDefined()
    if (request) {
      for (const rendered of [JSON.stringify(request), inspect(request), String(request)]) {
        expect(rendered).not.toContain(credentials.password)
        expect(rendered).not.toContain(
          Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'),
        )
        expect(rendered).not.toContain('Private title')
      }
      expect(request.authorization).toMatch(/^Basic /)
      expect(request.body).toBe(body)
    }
  })
  it('bounds response size and permits cancellation of a stalled fake transport', async () => {
    const { client } = fixture([{ status: 200, body: 'x'.repeat(1_048_577), etag: '"one"' }])
    await expect(client.get(credentials, resource)).rejects.toMatchObject({
      code: 'invalid_response',
    })
    const controller = new AbortController()
    const stalled = createCalDavWriteClient(() => new Promise(() => {})).get(
      credentials,
      resource,
      controller.signal,
    )
    controller.abort()
    await expect(stalled).rejects.toMatchObject({ code: 'timeout' })
  })
})
