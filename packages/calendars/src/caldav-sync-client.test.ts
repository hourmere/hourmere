import { describe, expect, it, vi } from 'vitest'
import { parseCalDavBusy } from './caldav-events.ts'
import { createCalDavSyncClient } from './caldav-sync-client.ts'
import type { CalDavRequest, CalDavResponse } from './caldav-transport.ts'

const credentials = {
  serverUrl: 'https://calendar.example.com/',
  username: 'owner@example.com',
  password: 'secret-app-password',
}
const input = {
  calendarUrl: 'https://calendar.example.com/cal/',
  start: '2026-03-01T00:00:00Z',
  end: '2026-04-01T00:00:00Z',
}
const xml = (body: string) =>
  `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`
const row = (href: string, etag: string, data?: string) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${etag}</d:getetag>${data === undefined ? '' : `<c:calendar-data><![CDATA[${data}]]></c:calendar-data>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
const event =
  'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260315T100000Z\r\nDTEND:20260315T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR'
const capabilities = (sync = true) =>
  xml(
    `<d:response><d:href>/cal/</d:href><d:propstat><d:prop>${sync ? '<d:supported-report-set><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report></d:supported-report-set><d:sync-token>token-1</d:sync-token>' : ''}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
  )
function fixture(responses: (string | CalDavResponse)[]) {
  const transport = vi.fn(async (_request: CalDavRequest): Promise<CalDavResponse> => {
    const response = responses.shift()
    if (response === undefined) throw new Error('unexpected request')
    return typeof response === 'string' ? { status: 207, body: response } : response
  })
  return { transport, client: createCalDavSyncClient(transport) }
}
const previous = {
  ...input,
  syncToken: 'token-0',
  etags: {
    'https://calendar.example.com/cal/a.ics': 'old',
    'https://calendar.example.com/cal/deleted.ics': 'deleted',
  },
}
describe('CalDAV bounded busy REPORT protocol', () => {
  // Synthetic provider-shaped fixtures; these are not live-provider compatibility claims.
  it.each([
    {
      provider: 'Nextcloud',
      path: '/remote.php/dav/calendars/alice/personal/',
      token: 'http://sabre.io/ns/sync/42',
      davPrefix: 'd',
      calPrefix: 'c',
      etag: '&quot;nextcloud-42&quot;',
    },
    {
      provider: 'iCloud',
      path: '/123456789/calendars/2B50F064-0406-45C2-AD63/',
      token: 'https://calendar.example.com/123456789/token/abc123',
      davPrefix: 'D',
      calPrefix: 'C',
      etag: '&quot;icloud-abc123&quot;',
    },
  ])(
    'initial $provider-shaped expanded recurrence, DST and exception response',
    async ({ path, token, davPrefix, calPrefix, etag }) => {
      const calendarUrl = `https://calendar.example.com${path}`
      const occurrence = (lines: string[]) =>
        ['BEGIN:VEVENT', 'UID:weekly-series', ...lines, 'END:VEVENT'].join('\r\n')
      // Provider expansion of 09:00 America/New_York: UTC shifts after March 8 DST.
      // March 15 exception moves to March 16; March 22 cancellation contributes no busy time.
      const expanded = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        occurrence([
          'RECURRENCE-ID:20260301T140000Z',
          'DTSTART:20260301T140000Z',
          'DTEND:20260301T150000Z',
        ]),
        occurrence([
          'RECURRENCE-ID:20260308T130000Z',
          'DTSTART:20260308T130000Z',
          'DTEND:20260308T140000Z',
        ]),
        occurrence([
          'RECURRENCE-ID:20260315T130000Z',
          'DTSTART:20260316T160000Z',
          'DTEND:20260316T170000Z',
        ]),
        occurrence([
          'RECURRENCE-ID:20260322T130000Z',
          'STATUS:CANCELLED',
          'DTSTART:20260322T130000Z',
          'DTEND:20260322T140000Z',
        ]),
        'END:VCALENDAR',
      ].join('\r\n')
      const allDay = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:holiday',
        'DTSTART;VALUE=DATE:20260320',
        'DTEND;VALUE=DATE:20260322',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n')
      const namespaces = (body: string) =>
        body
          .replaceAll('d:', `${davPrefix}:`)
          .replaceAll('xmlns:d=', `xmlns:${davPrefix}=`)
          .replaceAll('c:', `${calPrefix}:`)
          .replaceAll('xmlns:c=', `xmlns:${calPrefix}=`)
      const { client, transport } = fixture([
        namespaces(capabilities().replace('/cal/', path).replace('token-1', token)),
        namespaces(
          xml(
            row(`${path}series.ics`, etag, expanded) +
              row(`${path}holiday.ics`, '&quot;holiday-1&quot;', allDay),
          ),
        ),
      ])
      const result = await client.sync(credentials, { ...input, calendarUrl })
      expect(result).toMatchObject({ full: true, syncToken: token })
      expect(result.resources.map((resource) => resource.href)).toEqual([
        `${calendarUrl}series.ics`,
        `${calendarUrl}holiday.ics`,
      ])
      expect(
        result.resources
          .flatMap((resource) => parseCalDavBusy(resource.calendarData, input))
          .map(({ kind, start, end }) => ({ kind, start, end })),
      ).toEqual([
        { kind: 'timed', start: '2026-03-01T14:00:00Z', end: '2026-03-01T15:00:00Z' },
        { kind: 'timed', start: '2026-03-08T13:00:00Z', end: '2026-03-08T14:00:00Z' },
        { kind: 'timed', start: '2026-03-16T16:00:00Z', end: '2026-03-16T17:00:00Z' },
        { kind: 'all_day', start: '2026-03-20', end: '2026-03-22' },
      ])
      expect(transport.mock.calls[0]?.[0].method).toBe('PROPFIND')
      expect(transport.mock.calls[1]?.[0].method).toBe('REPORT')
      expect(transport.mock.calls[1]?.[0].url).toBe(calendarUrl)
      expect(transport.mock.calls[1]?.[0].body).toContain(
        '<c:expand start="20260301T000000Z" end="20260401T000000Z"/>',
      )
      expect(transport.mock.calls[1]?.[0].body).toContain(
        '<c:time-range start="20260301T000000Z" end="20260401T000000Z"/>',
      )
    },
  )
  it('applies incremental add/change/delete with expanded multiget and new token', async () => {
    const delta = xml(
      `${row('/cal/a.ics', 'a2')}${row('/cal/new.ics', 'n1')}<d:response><d:href>/cal/deleted.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response><d:sync-token>token-2</d:sync-token>`,
    )
    const { client, transport } = fixture([
      capabilities(),
      delta,
      xml(row('/cal/a.ics', 'a2', event) + row('/cal/new.ics', 'n1', event)),
    ])
    const result = await client.sync(credentials, { ...input, previous })
    expect(result.full).toBe(false)
    expect(result.deleted).toEqual(['https://calendar.example.com/cal/deleted.ics'])
    expect(result.etags).toEqual({
      'https://calendar.example.com/cal/a.ics': 'a2',
      'https://calendar.example.com/cal/new.ics': 'n1',
    })
    expect(result.syncToken).toBe('token-2')
    expect(transport.mock.calls[2]?.[0].body).toContain('<c:expand')
  })
  it('invalid token reconciles the entire bounded range', async () => {
    const { client, transport } = fixture([
      capabilities(),
      { status: 403, body: '<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>' },
      xml(row('/cal/a.ics', 'a2', event)),
    ])
    expect(await client.sync(credentials, { ...input, previous })).toMatchObject({
      full: true,
      syncToken: 'token-1',
    })
    expect(transport.mock.calls[2]?.[0].body).toContain('calendar-query')
  })
  it.each([405, 501])(
    'unsupported sync REPORT (%s) falls back to reconciliation',
    async (status) => {
      const { client } = fixture([capabilities(), { status, body: '' }, xml('')])
      expect(await client.sync(credentials, { ...input, previous })).toMatchObject({
        full: true,
        resources: [],
      })
    },
  )
  it('without advertised sync support always reconciles, regardless of stored token', async () => {
    const { client, transport } = fixture([
      capabilities(false),
      xml(row('/cal/a.ics', 'a2', event)),
    ])
    expect(await client.sync(credentials, { ...input, previous })).toMatchObject({
      full: true,
      syncToken: null,
    })
    expect(transport.mock.calls[1]?.[0].body).toContain('calendar-query')
  })
  it('moving horizon forces reconciliation even if a token exists', async () => {
    const { client, transport } = fixture([capabilities(), xml('')])
    await client.sync(credentials, {
      ...input,
      previous: { ...previous, end: '2026-03-31T00:00:00Z' },
    })
    expect(transport.mock.calls[1]?.[0].body).toContain('calendar-query')
  })
  it('etag races fail the entire incremental refresh', async () => {
    const { client } = fixture([
      capabilities(),
      xml(`${row('/cal/a.ics', 'a2')}<d:sync-token>t2</d:sync-token>`),
      xml(row('/cal/a.ics', 'a3', event)),
    ])
    await expect(client.sync(credentials, { ...input, previous })).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })
  it.each([
    xml(row('/cal/a.ics', 'a1')),
    '<broken>',
    'x'.repeat(1_048_577),
    '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d:multistatus xmlns:d="DAV:">&x;</d:multistatus>',
    xml(
      '<d:response><d:href>/cal/a.ics</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>',
    ),
  ])('rejects incomplete, malformed or oversized bodies', async (body) => {
    const { client } = fixture([capabilities(), body])
    await expect(client.sync(credentials, input)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })
  it.each([401, 403, 429, 500])('safe failure for HTTP %s', async (status) => {
    const { client } = fixture([{ status, body: credentials.password }])
    await expect(client.sync(credentials, input)).rejects.toThrow(
      /^CalDAV (unauthorized|forbidden|rate_limited|unavailable)$/,
    )
  })
  it('refuses private redirects and cross-origin resource hrefs before credential forwarding', async () => {
    const { client, transport } = fixture([
      { status: 307, body: '', location: 'https://127.0.0.1/cal/' },
    ])
    await expect(client.sync(credentials, input)).rejects.toMatchObject({
      code: 'destination_refused',
    })
    expect(transport).toHaveBeenCalledTimes(1)
    const crossOrigin = fixture([
      capabilities(),
      xml(row('https://other.example.com/cal/a.ics', 'a1', event)),
    ])
    await expect(crossOrigin.client.sync(credentials, input)).rejects.toMatchObject({
      code: 'destination_refused',
    })
  })
  it('redacts request credentials and discards provider exceptions', async () => {
    const transport = vi.fn(async (request: CalDavRequest): Promise<CalDavResponse> => {
      expect(JSON.stringify(request)).not.toContain(
        Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'),
      )
      expect(request.authorization).toMatch(/^Basic /)
      throw new Error(credentials.password)
    })
    await expect(createCalDavSyncClient(transport).sync(credentials, input)).rejects.toThrow(
      'CalDAV transport_failed',
    )
  })
})
