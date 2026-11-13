import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCalDavDiscovery } from './caldav-discovery.ts'
import type { CalDavResponse, CalDavTransport } from './caldav-transport.ts'

const credentials = {
  serverUrl: 'https://dav.example.com',
  username: 'host',
  password: 'mock-password',
}
const response = (href: string, props: string, status = '200 OK') =>
  `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat></d:response></d:multistatus>`
const entry = response(
  '/.well-known/caldav',
  '<d:current-user-principal><d:href>/principals/host/</d:href></d:current-user-principal>',
)
const principal = response(
  '/principals/host/',
  '<c:calendar-home-set><d:href>/calendars/host/</d:href></c:calendar-home-set>',
)
const calendar = response(
  '/calendars/host/work/',
  '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Work &amp; home</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>',
)
function mock(bodies = [entry, principal, calendar]) {
  return vi
    .fn<CalDavTransport>()
    .mockImplementation(async () => ({ status: 207, body: bodies.shift() ?? '' }))
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe('CalDAV discovery mock server', () => {
  it('discovers principal/home and VEVENT/writable collection without exposing credentials', async () => {
    const transport = mock()
    const result = await createCalDavDiscovery(transport).discover(credentials)
    expect(result).toEqual({
      principalUrl: 'https://dav.example.com/principals/host/',
      calendarHomeUrl: 'https://dav.example.com/calendars/host/',
      calendars: [
        {
          url: 'https://dav.example.com/calendars/host/work/',
          displayName: 'Work & home',
          supportsEvents: true,
          canWrite: true,
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain(credentials.password)
    expect(transport.mock.calls.map(([r]) => r.depth)).toEqual(['0', '0', '1'])
    const request = transport.mock.calls[0]?.[0]
    expect(request?.authorization).toBe(
      `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
    )
    for (const render of [
      (value: unknown) => JSON.stringify(value),
      (value: unknown) => inspect(value),
      (value: unknown) => String(value),
    ]) {
      expect(render(request)).toContain('[REDACTED]')
      expect(render(request)).not.toContain(request?.authorization)
      expect(render(request)).not.toContain(credentials.password)
    }
  })
  it.each(['http://dav.example.com', 'https://127.0.0.1', 'https://user:pass@dav.example.com'])(
    'refuses unsafe initial URL %s',
    async (serverUrl) => {
      const transport = mock()
      await expect(
        createCalDavDiscovery(transport).discover({ ...credentials, serverUrl }),
      ).rejects.toMatchObject({ code: 'destination_refused' })
      expect(transport).not.toHaveBeenCalled()
    },
  )
  it.each([
    'https://evil.example.com/path',
    'http://dav.example.com/path',
    'https://169.254.169.254/path',
  ])('refuses redirect credentials to %s', async (location) => {
    const transport = vi
      .fn<CalDavTransport>()
      .mockResolvedValue({ status: 302, body: '', location })
    await expect(createCalDavDiscovery(transport).discover(credentials)).rejects.toMatchObject({
      code: 'destination_refused',
    })
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('allows only configured additional origins and caps redirect loops', async () => {
    const transport = vi
      .fn<CalDavTransport>()
      .mockResolvedValue({ status: 302, body: '', location: 'https://shard.example.com/' })
    await expect(
      createCalDavDiscovery(transport, { allowedOrigins: ['https://shard.example.com'] }).discover(
        credentials,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(transport).toHaveBeenCalledTimes(4)
  })
  it.each([
    ['failed property', entry.replace('200 OK', '404 Not Found'), 'invalid_response'],
    ['wrong namespace', entry.replace('DAV:', 'urn:evil'), 'invalid_response'],
    ['DTD', `<!DOCTYPE x [<!ENTITY x "secret">]>${entry}`, 'invalid_response'],
    [
      'cross-origin principal',
      entry.replace('/principals/host/', 'https://evil.example.com/'),
      'destination_refused',
    ],
    [
      'oversized body',
      entry.replace('</d:prop>', `<!--${'x'.repeat(1_048_577)}--></d:prop>`),
      'invalid_response',
    ],
    ['malformed XML', '<broken>', 'invalid_response'],
  ])('rejects %s with its specific error', async (_name, body, code) => {
    await expect(
      createCalDavDiscovery(mock([body, principal, calendar])).discover(credentials),
    ).rejects.toMatchObject({ code })
  })
  it.each([
    ['https://dav.example.com/remote.php/dav', '/remote.php/dav/', '/remote.php/principals/host/'],
    ['https://dav.example.com', '/context/', '/.well-known/principals/host/'],
  ])('accepts canonical Depth:0 href for %s', async (serverUrl, canonical, principalPath) => {
    const transport = mock([
      response(
        canonical,
        '<d:current-user-principal><d:href>principals/host/</d:href></d:current-user-principal>',
      ),
      response(
        principalPath,
        '<c:calendar-home-set><d:href>calendars/</d:href></c:calendar-home-set>',
      ),
      calendar,
    ])
    const result = await createCalDavDiscovery(transport).discover({ ...credentials, serverUrl })
    expect(result.principalUrl).toBe(`https://dav.example.com${principalPath}`)
    expect(result.calendarHomeUrl).toBe(`${result.principalUrl}calendars/`)
  })
  it.each([
    ['/nested/request/start', '../calendars/x/', '/nested/calendars/x/'],
    ['/nested/request/start', 'x/', '/nested/request/x/'],
    ['/nested/request/start', '/abs/', '/abs/'],
    ['/nested/request/start/', '../calendars/x/', '/nested/request/calendars/x/'],
    ['/nested/request/start/', 'x/', '/nested/request/start/x/'],
    ['/nested/request/start/', '/abs/', '/abs/'],
    ['/.well-known/caldav', '../calendars/x/', '/calendars/x/'],
    ['/.well-known/caldav', 'x/', '/.well-known/x/'],
    ['/.well-known/caldav', '/abs/', '/abs/'],
  ])('resolves property href %s + %s against each request URI', async (path, href, expected) => {
    // Different response paths ensure neither property borrows the canonical response URL.
    const transport = mock([
      response(
        '/canonical/entry/',
        `<d:current-user-principal><d:href>${href}</d:href></d:current-user-principal>`,
      ),
      response(
        '/canonical/principal/',
        `<c:calendar-home-set><d:href>${href}</d:href></c:calendar-home-set>`,
      ),
      calendar,
    ])
    const serverUrl = `https://dav.example.com${path}`
    const result = await createCalDavDiscovery(transport).discover({ ...credentials, serverUrl })
    expect(result.principalUrl).toBe(`https://dav.example.com${expected}`)
    expect(result.calendarHomeUrl).toBe(new URL(href, result.principalUrl).href)
    expect(transport.mock.calls.map(([request]) => request.url)).toEqual([
      serverUrl,
      result.principalUrl,
      result.calendarHomeUrl,
    ])
  })
  it('discovers a redirect-free server with hrefs relative to nested request paths', async () => {
    const routes: Record<string, string> = {
      '/dav/nested/bootstrap': response(
        '/canonical/bootstrap/',
        '<d:current-user-principal><d:href>x/</d:href></d:current-user-principal>',
      ),
      '/dav/nested/x/': response(
        '/canonical/principal/',
        '<c:calendar-home-set><d:href>../calendars/x/</d:href></c:calendar-home-set>',
      ),
      '/dav/nested/calendars/x/': response(
        'work/',
        '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>',
      ),
    }
    const transport = vi.fn<CalDavTransport>().mockImplementation(async ({ url }) => {
      const body = routes[new URL(url).pathname]
      return body ? { status: 207, body } : { status: 404, body: '' }
    })
    const result = await createCalDavDiscovery(transport).discover({
      ...credentials,
      serverUrl: 'https://dav.example.com/dav/nested/bootstrap',
    })
    expect(result).toMatchObject({
      principalUrl: 'https://dav.example.com/dav/nested/x/',
      calendarHomeUrl: 'https://dav.example.com/dav/nested/calendars/x/',
      calendars: [{ url: 'https://dav.example.com/dav/nested/calendars/x/work/' }],
    })
    expect(transport).toHaveBeenCalledTimes(3)
  })
  it('uses the final request URI after redirects for relative properties', async () => {
    const transport = vi
      .fn<CalDavTransport>()
      .mockResolvedValueOnce({ status: 302, body: '', location: '/redirected/bootstrap' })
      .mockResolvedValueOnce({
        status: 207,
        body: response(
          '/canonical/bootstrap/',
          '<d:current-user-principal><d:href>x/</d:href></d:current-user-principal>',
        ),
      })
      .mockResolvedValueOnce({ status: 307, body: '', location: '/another/principals/host/' })
      .mockResolvedValueOnce({
        status: 207,
        body: response(
          '/canonical/principal/',
          '<c:calendar-home-set><d:href>../calendars/x/</d:href></c:calendar-home-set>',
        ),
      })
      .mockResolvedValueOnce({ status: 207, body: calendar })
    const result = await createCalDavDiscovery(transport).discover(credentials)
    expect(result.principalUrl).toBe('https://dav.example.com/redirected/x/')
    expect(result.calendarHomeUrl).toBe('https://dav.example.com/another/principals/calendars/x/')
    expect(transport.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
      '/.well-known/caldav',
      '/redirected/bootstrap',
      '/redirected/x/',
      '/another/principals/host/',
      '/another/principals/calendars/x/',
    ])
  })
  it('selects a trailing-slash match among multiple responses', async () => {
    const canonical = entry.replace('/.well-known/caldav', '/.well-known/caldav/')
    const unrelated = response('/wrong/', '').match(/<d:response>[\s\S]*<\/d:response>/)?.[0] ?? ''
    const transport = mock([
      canonical.replace('</d:multistatus>', `${unrelated}</d:multistatus>`),
      principal,
      calendar,
    ])
    await expect(createCalDavDiscovery(transport).discover(credentials)).resolves.toMatchObject({
      principalUrl: 'https://dav.example.com/principals/host/',
    })
  })
  it.each([
    [
      'ambiguous different paths',
      entry
        .replace('/.well-known/caldav', '/wrong')
        .replace(
          '</d:multistatus>',
          '<d:response><d:href>/another</d:href></d:response></d:multistatus>',
        ),
      'invalid_response',
    ],
    [
      'cross-origin response',
      entry.replace('/.well-known/caldav', 'https://evil.example.com/context/'),
      'destination_refused',
    ],
  ])('rejects %s in Depth:0 responses', async (_name, body, code) => {
    await expect(
      createCalDavDiscovery(mock([body, principal, calendar])).discover(credentials),
    ).rejects.toMatchObject({ code })
  })
  it('requires Depth:0 response hrefs to stay on the request origin even when another origin is trusted', async () => {
    await expect(
      createCalDavDiscovery(
        mock([
          entry.replace('/.well-known/caldav', 'https://shard.example.com/context/'),
          principal,
          calendar,
        ]),
        { allowedOrigins: ['https://shard.example.com'] },
      ).discover(credentials),
    ).rejects.toMatchObject({ code: 'destination_refused' })
  })
  it.each([
    ['', true],
    ['<c:supported-calendar-component-set/>', false],
    [
      '<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>',
      false,
    ],
    [
      '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>',
      true,
    ],
  ])('derives event support from component set %s', async (components, supportsEvents) => {
    const result = await createCalDavDiscovery(
      mock([
        entry,
        principal,
        response('/calendar/', `<d:resourcetype><c:calendar/></d:resourcetype>${components}`),
      ]),
    ).discover(credentials)
    expect(result.calendars[0]?.supportsEvents).toBe(supportsEvents)
  })
  it.each([
    ['write', true],
    ['all', true],
    ['write-content', true],
    ['bind', true],
    ['read', false],
    ['', false],
  ])('derives write capability from privilege %s', async (privilege, canWrite) => {
    const privileges = privilege
      ? `<d:current-user-privilege-set><d:privilege><d:${privilege}/></d:privilege></d:current-user-privilege-set>`
      : ''
    const result = await createCalDavDiscovery(
      mock([
        entry,
        principal,
        response('/calendar/', `<d:resourcetype><c:calendar/></d:resourcetype>${privileges}`),
      ]),
    ).discover(credentials)
    expect(result.calendars[0]?.canWrite).toBe(canWrite)
  })
  it('does not infer write privileges or event support from other components', async () => {
    const result = await createCalDavDiscovery(
      mock([
        entry,
        principal,
        calendar.replace('VEVENT', 'VTODO').replace('<d:write/>', '<d:read/>'),
      ]),
    ).discover(credentials)
    expect(result.calendars[0]).toMatchObject({ canWrite: false, supportsEvents: false })
  })
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ] as const)('classifies status %s without returning provider body', async (status, code) => {
    await expect(
      createCalDavDiscovery(async () => ({ status, body: credentials.password })).discover(
        credentials,
      ),
    ).rejects.toMatchObject({ code, message: `CalDAV ${code}` })
  })
  it('bounds stalled injected transport and sanitizes transport errors', async () => {
    const controller = new AbortController()
    const promise = createCalDavDiscovery(() => new Promise<CalDavResponse>(() => {})).discover(
      credentials,
      controller.signal,
    )
    controller.abort()
    await expect(promise).rejects.toMatchObject({ code: 'timeout' })
    await expect(
      createCalDavDiscovery(async () => {
        throw Error(credentials.password)
      }).discover(credentials),
    ).rejects.toMatchObject({ message: 'CalDAV transport_failed' })
  })
  it('handles CDATA and sanitizes synchronous failures and pre-abort reasons', async () => {
    const result = await createCalDavDiscovery(
      mock([entry, principal, calendar.replace('Work &amp; home', '<![CDATA[Work & home]]>')]),
    ).discover(credentials)
    expect(result.calendars[0]?.displayName).toBe('Work & home')
    await expect(
      createCalDavDiscovery(() => {
        throw Error('secret')
      }).discover(credentials),
    ).rejects.toMatchObject({ message: 'CalDAV transport_failed' })
    const controller = new AbortController()
    controller.abort('secret')
    await expect(
      createCalDavDiscovery(mock()).discover(credentials, controller.signal),
    ).rejects.toMatchObject({ message: 'CalDAV timeout' })
  })
  it.each(['name:password', 'name\u0000', 'x'.repeat(1025)])(
    'rejects malformed Basic usernames',
    async (username) => {
      const transport = mock()
      await expect(
        createCalDavDiscovery(transport).discover({ ...credentials, username }),
      ).rejects.toMatchObject({ code: 'unauthorized' })
      expect(transport).not.toHaveBeenCalled()
    },
  )
  it.each(['https://dav.example.com/?token=x', 'https://dav.example.com/path?'])(
    'refuses query-bearing server URL',
    async (serverUrl) => {
      const transport = mock()
      await expect(
        createCalDavDiscovery(transport).discover({ ...credentials, serverUrl }),
      ).rejects.toMatchObject({ code: 'destination_refused' })
      expect(transport).not.toHaveBeenCalled()
    },
  )
  it('rejects raw href controls and immutable origin configuration changes', async () => {
    await expect(
      createCalDavDiscovery(
        mock([entry.replace('/principals/host/', '/principals/ho&#10;st/')]),
      ).discover(credentials),
    ).rejects.toMatchObject({ code: 'destination_refused' })
    const allowedOrigins: string[] = []
    const client = createCalDavDiscovery(
      mock([entry.replace('/principals/host/', 'https://evil.example.com/')]),
      { allowedOrigins },
    )
    allowedOrigins.push('https://evil.example.com')
    await expect(client.discover(credentials)).rejects.toMatchObject({
      code: 'destination_refused',
    })
  })
  it.each([
    entry.replace('</d:prop>', `${'<d:x>'.repeat(33)}${'</d:x>'.repeat(33)}</d:prop>`),
    entry.replace('</d:prop>', `${'<d:x/>'.repeat(10001)}</d:prop>`),
  ])('bounds XML depth and node count', async (body) => {
    await expect(
      createCalDavDiscovery(mock([body, principal, calendar])).discover(credentials),
    ).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })
  it('bounds collection count', async () => {
    const item = calendar.match(/<d:response>[\s\S]*<\/d:response>/)?.[0] ?? ''
    await expect(
      createCalDavDiscovery(
        mock([entry, principal, calendar.replace(item, item.repeat(257))]),
      ).discover(credentials),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('enforces thirty-second discovery deadline for a hung adapter', async () => {
    vi.useFakeTimers()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const c = new AbortController()
      setTimeout(() => c.abort(), ms)
      return c.signal
    })
    const assertion = expect(
      createCalDavDiscovery(() => new Promise(() => {})).discover(credentials),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(timeout).toHaveBeenCalledWith(30000)
    await vi.advanceTimersByTimeAsync(30000)
    await assertion
  })
})
