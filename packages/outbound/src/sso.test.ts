import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), httpRequest: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }))
vi.mock('node:https', () => ({ request: network.request }))
vi.mock('node:http', () => ({ request: network.httpRequest }))

import { SSO_TRANSPORT_LIMITS, SsoTransportError, sendSsoRequest, ssoUrl } from './sso.ts'
import { parseSsoPrivateTargets } from './sso-private-targets.ts'

type Callback = (res: PassThrough) => void

/** A fake request whose response arrives when `end` is called, unless `hold` keeps it. */
function respond(
  mock: typeof network.request,
  status = 200,
  body = '{"ok":true}',
  headers: Record<string, string> = { 'content-type': 'application/json' },
) {
  mock.mockImplementation((_url: URL, _options: Record<string, unknown>, callback: Callback) => {
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: () => {
        const res = Object.assign(new PassThrough(), {
          statusCode: status,
          headers,
          complete: false,
        })
        callback(res)
        // A response the transport refused is already destroyed.
        if (!res.destroyed) res.end(body)
        res.complete = true
      },
    })
    return req
  })
}

/** Requests that never answer until released, to observe the concurrency limits. */
function holdResponses() {
  const pending: (() => void)[] = []
  network.request.mockImplementation((_url: URL, _options: unknown, callback: Callback) =>
    Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: () =>
        pending.push(() => {
          const res = Object.assign(new PassThrough(), {
            statusCode: 200,
            headers: {},
            complete: false,
          })
          callback(res)
          res.end('{}')
          res.complete = true
        }),
    }),
  )
  return pending
}

const answer = (address: string) => ({ address, family: address.includes(':') ? 6 : 4 })
const publicRequest = (url = 'https://idp.example.com/.well-known/openid-configuration') => ({
  url,
  privateTargets: [],
})

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SsoTransportError)
    expect(Object.keys(error as object).sort()).toEqual(['code', 'name'])
    expect((error as Error).cause).toBeUndefined()
    return (error as SsoTransportError).code
  }
  throw new Error('expected the SSO transport to refuse')
}

/** A request over the limits fails at once; one that waits for a slot would still be pending. */
const immediately = (promise: Promise<unknown>) =>
  Promise.race([
    refusal(promise),
    new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 200)),
  ])

let consoleCalls: unknown[][]
beforeEach(() => {
  consoleCalls = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, method).mockImplementation((...args) => consoleCalls.push(args))
})
afterEach(() => {
  // The profile never logs, whatever the outcome.
  expect(consoleCalls).toEqual([])
  vi.useRealTimers()
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

describe('SSO destination syntax', () => {
  it.each([
    'http://idp.example.com/',
    'https://idp.example.com:8443/',
    'https://user:secret@idp.example.com/',
    'https://idp.example.com/#fragment',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://8.8.8.8/',
    'https://localhost/',
    'https://idp.internal/',
    'https://idp.local/',
    'https://idp/',
    'https://idp.example.com./',
    'https://idp.example.com/\nvalue',
    'https://idp.example.com\\@internal/',
    'ftp://idp.example.com/',
    `https://idp.example.com/${'a'.repeat(2048)}`,
    `https://idp.example.com/${String.fromCharCode(0xd800)}`,
  ])('refuses %s before DNS or a socket', async (url) => {
    expect(ssoUrl(url, [])).toBeUndefined()
    respond(network.request)
    expect(await refusal(sendSsoRequest(publicRequest(url)))).toBe('destination_refused')
    expect(network.lookup).not.toHaveBeenCalled()
    expect(network.request).not.toHaveBeenCalled()
    expect(network.httpRequest).not.toHaveBeenCalled()
  })

  it('keeps a public HTTPS destination, its path and its query', () => {
    expect(ssoUrl('https://IdP.example.com:443/tenant/v2.0?p=signin', [])).toBe(
      'https://idp.example.com/tenant/v2.0?p=signin',
    )
  })
})

// Each special-purpose range by its first and last address, and the public neighbours
// just outside it, so dropping a range or changing its prefix length by one is caught.
const refusedEdges = [
  ['0.0.0.0', '0.255.255.255'],
  ['10.0.0.0', '10.255.255.255'],
  ['100.64.0.0', '100.127.255.255'],
  ['127.0.0.0', '127.255.255.255'],
  ['169.254.0.0', '169.254.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.0.0.0', '192.0.0.255'],
  ['192.0.2.0', '192.0.2.255'],
  ['192.31.196.0', '192.31.196.255'],
  ['192.52.193.0', '192.52.193.255'],
  ['192.175.48.0', '192.175.48.255'],
  ['192.88.99.0', '192.88.99.255'],
  ['192.168.0.0', '192.168.255.255'],
  ['198.18.0.0', '198.19.255.255'],
  ['198.51.100.0', '198.51.100.255'],
  ['203.0.113.0', '203.0.113.255'],
  ['224.0.0.0', '239.255.255.255'],
  ['240.0.0.0', '255.255.255.255'],
  ['2620:4f:8000::', '2620:4f:8000:ffff:ffff:ffff:ffff:ffff'],
  ['2001::', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2002::', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['3fff::', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'],
  // Outside global unicast 2000::/3 entirely.
  ['::', '1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['4000::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
].flat()
const nonGlobal = [
  '::1',
  '::ffff:8.8.8.8',
  '::ffff:808:808',
  '64:ff9b::808:808',
  '64:ff9b:1::808:808',
  '100::1',
  'fc00::1',
  'fd12::1',
  'fe80::1',
  'ff02::1',
]
const publicNeighbours = [
  '1.0.0.0',
  '9.255.255.255',
  '11.0.0.0',
  '100.63.255.255',
  '100.128.0.0',
  '126.255.255.255',
  '128.0.0.0',
  '169.253.255.255',
  '169.255.0.0',
  '172.15.255.255',
  '172.32.0.0',
  '191.255.255.255',
  '192.0.1.0',
  '192.0.3.0',
  '192.31.195.255',
  '192.31.197.0',
  '192.52.192.255',
  '192.52.194.0',
  '192.175.47.255',
  '192.175.49.0',
  '192.88.98.255',
  '192.88.100.0',
  '192.167.255.255',
  '192.169.0.0',
  '198.17.255.255',
  '198.20.0.0',
  '198.51.99.255',
  '198.51.101.0',
  '203.0.112.255',
  '203.0.114.0',
  '223.255.255.255',
  '2000::',
  '2620:4f:7fff:ffff:ffff:ffff:ffff:ffff',
  '2620:4f:8001::',
  '2001:200::',
  '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff',
  '2001:db9::',
  '2003::',
  '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  '3fff:1000::',
  '3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
]

describe('SSO DNS answers for a public destination', () => {
  it.each([...refusedEdges, ...nonGlobal])(
    'refuses special-purpose answer %s before opening a socket',
    async (address) => {
      network.lookup.mockResolvedValue([answer(address)])
      respond(network.request)
      expect(await refusal(sendSsoRequest(publicRequest()))).toBe('destination_refused')
      expect(network.lookup).toHaveBeenCalledExactlyOnceWith('idp.example.com', {
        all: true,
        verbatim: true,
      })
      expect(network.request).not.toHaveBeenCalled()
    },
  )

  it.each(publicNeighbours)('accepts the public neighbour %s', async (address) => {
    network.lookup.mockResolvedValue([answer(address)])
    respond(network.request)
    const response = await sendSsoRequest(publicRequest())
    expect(response.status).toBe(200)
    expect(network.request).toHaveBeenCalledOnce()
  })

  it.each([
    [['8.8.8.8', '10.0.0.1']],
    [['10.0.0.1', '8.8.8.8']],
    [['2606:4700:4700::1111', 'fd12::1']],
    [['8.8.8.8', '::ffff:127.0.0.1']],
    [['8.8.8.8', '169.254.169.254']],
  ])('refuses mixed answers %j', async (addresses) => {
    network.lookup.mockResolvedValue(addresses.map(answer))
    respond(network.request)
    expect(await refusal(sendSsoRequest(publicRequest()))).toBe('destination_refused')
    expect(network.request).not.toHaveBeenCalled()
  })

  it.each([
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
  ])('refuses the IPv4-mapped IPv6 answer %s', async (address) => {
    network.lookup.mockResolvedValue([answer(address)])
    respond(network.request)
    expect(await refusal(sendSsoRequest(publicRequest()))).toBe('destination_refused')
    expect(network.request).not.toHaveBeenCalled()
  })

  it.each([
    null,
    undefined,
    {},
    { length: 1 },
    [],
    [null],
    [{ address: '8.8.8.8', family: 6 }],
    [{ address: '8.8.8.8' }],
    [{ address: 'idp.example.com', family: 4 }],
    Array.from({ length: SSO_TRANSPORT_LIMITS.ssoMaximumDnsAnswers + 1 }, (_, i) =>
      answer(`8.8.8.${i + 1}`),
    ),
  ])('refuses the malformed or oversized DNS result %j', async (result) => {
    network.lookup.mockResolvedValue(result)
    respond(network.request)
    expect(await refusal(sendSsoRequest(publicRequest()))).toBe('destination_refused')
    expect(network.request).not.toHaveBeenCalled()
  })

  it('accepts exactly the maximum number of public answers and pins the first', async () => {
    network.lookup.mockResolvedValue(
      Array.from({ length: SSO_TRANSPORT_LIMITS.ssoMaximumDnsAnswers }, (_, i) =>
        answer(`8.8.8.${i + 1}`),
      ),
    )
    respond(network.request)
    expect((await sendSsoRequest(publicRequest())).status).toBe(200)
    network.request.mock.calls[0]?.[1].lookup('idp.example.com', {}, (_: unknown, ip: string) =>
      expect(ip).toBe('8.8.8.1'),
    )
  })

  it('resolves again on every request and refuses a host that rebinds to a private address', async () => {
    network.lookup
      .mockResolvedValueOnce([answer('8.8.8.8')])
      .mockResolvedValueOnce([answer('10.0.0.1')])
    respond(network.request)
    expect((await sendSsoRequest(publicRequest())).status).toBe(200)
    expect(await refusal(sendSsoRequest(publicRequest()))).toBe('destination_refused')
    expect(network.lookup).toHaveBeenCalledTimes(2)
    expect(network.request).toHaveBeenCalledOnce()
  })

  it('sanitizes DNS failures', async () => {
    network.lookup.mockRejectedValue(new Error('synthetic resolver detail idp.example.com'))
    expect(await refusal(sendSsoRequest(publicRequest()))).toBe('dns_failed')
    expect(network.request).not.toHaveBeenCalled()
  })
})

describe('pinned SSO request options', () => {
  it.each(['8.8.8.8', '2606:4700:4700::1111'])(
    'connects only to %s while TLS verifies the original hostname',
    async (address) => {
      network.lookup.mockResolvedValue([answer(address)])
      respond(network.request)
      await sendSsoRequest({
        ...publicRequest('https://idp.example.com/token'),
        method: 'POST',
        body: 'grant_type=authorization_code',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
      const [url, options] = network.request.mock.calls[0] ?? []
      expect(url.href).toBe('https://idp.example.com/token')
      expect(options).toMatchObject({
        agent: false,
        family: answer(address).family,
        servername: 'idp.example.com',
        rejectUnauthorized: true,
        maxHeaderSize: SSO_TRANSPORT_LIMITS.ssoMaximumHeaderBytes,
        method: 'POST',
      })
      expect(options.signal).toBeInstanceOf(AbortSignal)
      expect(options.headers).toEqual({
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '29',
        'accept-encoding': 'gzip, br',
        'user-agent': 'Hourmere-SSO/1',
      })
      const pinned = vi.fn()
      options.lookup('idp.example.com', {}, pinned)
      expect(pinned).toHaveBeenCalledExactlyOnceWith(null, address, answer(address).family)
      expect(network.lookup).toHaveBeenCalledOnce()
    },
  )

  it('starts the connection and response deadlines from the pinned limits', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    network.lookup.mockResolvedValue([answer('8.8.8.8')])
    respond(network.request)
    await sendSsoRequest(publicRequest())
    expect(timeout.mock.calls).toEqual([
      [SSO_TRANSPORT_LIMITS.ssoConnectTimeout],
      [SSO_TRANSPORT_LIMITS.ssoResponseTimeout],
    ])
  })

  it('stops at the connection deadline while DNS has not answered', async () => {
    const connect = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
      ms === SSO_TRANSPORT_LIMITS.ssoConnectTimeout ? connect.signal : new AbortController().signal,
    )
    network.lookup.mockImplementation(() => new Promise(() => {}))
    const pending = refusal(sendSsoRequest(publicRequest()))
    connect.abort()
    expect(await pending).toBe('connect_timeout')
    expect(network.request).not.toHaveBeenCalled()
  })

  it('stops when the caller aborts', async () => {
    const caller = new AbortController()
    network.lookup.mockImplementation(() => new Promise(() => {}))
    const pending = refusal(sendSsoRequest({ ...publicRequest(), signal: caller.signal }))
    caller.abort()
    expect(await pending).toBe('aborted')
  })

  it.each([301, 302, 303, 307, 308])(
    'refuses a %i redirect without contacting its location',
    async (status) => {
      network.lookup.mockResolvedValue([answer('8.8.8.8')])
      respond(network.request, status, 'moved', { location: 'https://127.0.0.1/' })
      expect(await refusal(sendSsoRequest(publicRequest()))).toBe('redirect_refused')
      expect(network.request).toHaveBeenCalledOnce()
      expect(network.lookup).toHaveBeenCalledOnce()
    },
  )

  it.each(['deflate', 'gzip, gzip', 'compress', 'zstd', 'br, gzip'])(
    'refuses the %s content coding instead of guessing',
    async (encoding) => {
      network.lookup.mockResolvedValue([answer('8.8.8.8')])
      respond(network.request, 200, 'x', { 'content-encoding': encoding })
      expect(await refusal(sendSsoRequest(publicRequest()))).toBe('unsupported_encoding')
    },
  )

  it('refuses a declared length above the response limit before reading the body', async () => {
    network.lookup.mockResolvedValue([answer('8.8.8.8')])
    respond(network.request, 200, '{}', {
      'content-length': String(SSO_TRANSPORT_LIMITS.ssoMaximumResponseBytes + 1),
    })
    expect(await refusal(sendSsoRequest(publicRequest()))).toBe('response_too_large')
  })

  it('returns an error status with its bounded body, for the caller to interpret', async () => {
    network.lookup.mockResolvedValue([answer('8.8.8.8')])
    respond(network.request, 400, '{"error":"invalid_grant"}')
    const response = await sendSsoRequest(publicRequest())
    expect(response.status).toBe(400)
    expect(response.body.toString()).toBe('{"error":"invalid_grant"}')
    expect(response.contentType).toBe('application/json')
  })
})

describe('SSO_PRIVATE_TARGETS routing', () => {
  const targets = parseSsoPrivateTargets('idp.internal:8443,10.0.0.5:9443,[fd12::5]:443')
  const privateRequest = (url: string, extra: object = {}) => ({
    url,
    privateTargets: targets,
    ...extra,
  })

  it.each(['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', 'fd12::1', '::1'])(
    'permits the exact listed host and port resolving to private address %s',
    async (address) => {
      network.lookup.mockResolvedValue([answer(address)])
      respond(network.request)
      expect((await sendSsoRequest(privateRequest('https://idp.internal:8443/realm'))).status).toBe(
        200,
      )
      const options = network.request.mock.calls[0]?.[1]
      expect(options.servername).toBe('idp.internal')
      expect(options.rejectUnauthorized).toBe(true)
      const pinned = vi.fn()
      options.lookup('idp.internal', {}, pinned)
      expect(pinned).toHaveBeenCalledWith(null, address, answer(address).family)
    },
  )

  it.each([
    'https://idp.internal:8444/realm',
    'https://idp.internal/realm',
    'https://other.internal:8443/realm',
    'https://idp.internal.:8443/realm',
    'https://10.0.0.5:9444/realm',
    'https://10.0.0.6:9443/realm',
    'https://[fd12::6]/realm',
  ])('refuses %s, which is not exactly a listed host and port, before DNS', async (url) => {
    respond(network.request)
    expect(await refusal(sendSsoRequest(privateRequest(url)))).toBe('destination_refused')
    expect(network.lookup).not.toHaveBeenCalled()
    expect(network.request).not.toHaveBeenCalled()
  })

  it('refuses another hostname even when it resolves to the listed address', async () => {
    network.lookup.mockResolvedValue([answer('10.0.0.5')])
    respond(network.request)
    for (const url of ['https://alias.internal:9443/', 'https://alias.internal:8443/'])
      expect(await refusal(sendSsoRequest(privateRequest(url)))).toBe('destination_refused')
    expect(network.lookup).not.toHaveBeenCalled()
  })

  it('matches IP literal entries by the literal, without DNS', async () => {
    respond(network.request)
    expect((await sendSsoRequest(privateRequest('https://10.0.0.5:9443/'))).status).toBe(200)
    expect((await sendSsoRequest(privateRequest('https://[fd12:0::5]/'))).status).toBe(200)
    expect(network.lookup).not.toHaveBeenCalled()
    expect(network.request.mock.calls.map(([, options]) => options.servername)).toEqual([
      undefined,
      undefined,
    ])
  })

  it.each([
    'http://idp.internal:8443/realm',
    'http://10.0.0.5:9443/realm',
    'http://[fd12::5]:443/realm',
  ])('refuses plain HTTP to the listed target %s', async (url) => {
    respond(network.httpRequest)
    expect(await refusal(sendSsoRequest(privateRequest(url)))).toBe('destination_refused')
    expect(network.lookup).not.toHaveBeenCalled()
    expect(network.httpRequest).not.toHaveBeenCalled()
  })

  it.each([
    [['8.8.8.8']],
    [['127.0.0.1', '8.8.8.8']],
    [['169.254.169.254']],
    [['100.100.100.200']],
    [['fd00:ec2::254']],
    [['fe80::1']],
    [['::ffff:10.0.0.1']],
    [['::ffff:a00:1']],
    [['100.64.0.1']],
  ])('refuses a listed host whose answers include ineligible %j', async (addresses) => {
    network.lookup.mockResolvedValue(addresses.map(answer))
    respond(network.request)
    expect(await refusal(sendSsoRequest(privateRequest('https://idp.internal:8443/')))).toBe(
      'destination_refused',
    )
    expect(network.request).not.toHaveBeenCalled()
  })

  it('applies the policy on every request: a listed host that rebinds is refused', async () => {
    network.lookup
      .mockResolvedValueOnce([answer('10.0.0.7')])
      .mockResolvedValueOnce([answer('169.254.169.254')])
      .mockResolvedValueOnce([answer('8.8.8.8')])
    respond(network.request)
    expect((await sendSsoRequest(privateRequest('https://idp.internal:8443/'))).status).toBe(200)
    expect(await refusal(sendSsoRequest(privateRequest('https://idp.internal:8443/')))).toBe(
      'destination_refused',
    )
    expect(await refusal(sendSsoRequest(privateRequest('https://idp.internal:8443/')))).toBe(
      'destination_refused',
    )
    expect(network.lookup).toHaveBeenCalledTimes(3)
    expect(network.request).toHaveBeenCalledOnce()
  })

  it('routes nothing private when the setting is empty or absent', async () => {
    network.lookup.mockResolvedValue([answer('10.0.0.5')])
    respond(network.request)
    for (const privateTargets of [parseSsoPrivateTargets(), parseSsoPrivateTargets('  ')])
      for (const url of [
        'https://idp.internal:8443/',
        'https://10.0.0.5:9443/',
        'https://localhost:8443/',
      ])
        expect(await refusal(sendSsoRequest({ url, privateTargets }))).toBe('destination_refused')
    // A public-looking name resolving privately is refused too.
    expect(await refusal(sendSsoRequest(publicRequest()))).toBe('destination_refused')
    expect(network.request).not.toHaveBeenCalled()
  })

  it('makes a listed host authoritative even when it has public syntax', async () => {
    const listed = parseSsoPrivateTargets('idp.example.com:443')
    network.lookup.mockResolvedValue([answer('8.8.8.8')])
    respond(network.request)
    expect(
      await refusal(sendSsoRequest({ url: 'https://idp.example.com/', privateTargets: listed })),
    ).toBe('destination_refused')
    expect(network.request).not.toHaveBeenCalled()
  })
})

describe('separately acknowledged loopback HTTP trial', () => {
  const targets = parseSsoPrivateTargets('localhost:8080,127.0.0.1:8081,idp.internal:8082')
  const trial = (url: string, loopbackHttpTrial = true) => ({
    url,
    privateTargets: targets,
    loopbackHttpTrial,
  })

  it('permits plain HTTP only to a listed loopback name or literal with loopback answers', async () => {
    network.lookup.mockResolvedValue([answer('127.0.0.1')])
    respond(network.httpRequest)
    expect((await sendSsoRequest(trial('http://localhost:8080/realm'))).status).toBe(200)
    expect((await sendSsoRequest(trial('http://127.0.0.1:8081/realm'))).status).toBe(200)
    expect(network.lookup).toHaveBeenCalledOnce()
    expect(network.httpRequest).toHaveBeenCalledTimes(2)
    expect(network.request).not.toHaveBeenCalled()
  })

  it.each([
    ['without the acknowledgement', 'http://localhost:8080/', false],
    ['for an unlisted port', 'http://localhost:8079/', true],
    ['for a listed non-loopback name', 'http://idp.internal:8082/', true],
    ['for an unlisted loopback literal', 'http://127.0.0.2:8081/', true],
  ])('refuses plain HTTP %s before DNS', async (_, url, acknowledged) => {
    respond(network.httpRequest)
    expect(await refusal(sendSsoRequest(trial(url, acknowledged)))).toBe('destination_refused')
    expect(network.lookup).not.toHaveBeenCalled()
    expect(network.httpRequest).not.toHaveBeenCalled()
  })

  it.each([[['10.0.0.1']], [['127.0.0.1', '10.0.0.1']], [['fd12::1']]])(
    'refuses the trial when localhost answers %j',
    async (addresses) => {
      network.lookup.mockResolvedValue(addresses.map(answer))
      respond(network.httpRequest)
      expect(await refusal(sendSsoRequest(trial('http://localhost:8080/')))).toBe(
        'destination_refused',
      )
      expect(network.httpRequest).not.toHaveBeenCalled()
    },
  )
})

describe('SSO transport concurrency', () => {
  it('admits a bounded number of requests per origin and per process, then fails fast', async () => {
    const { ssoMaximumConcurrentRequests: total, ssoMaximumConcurrentRequestsPerOrigin: each } =
      SSO_TRANSPORT_LIMITS
    network.lookup.mockResolvedValue([answer('8.8.8.8')])
    const pending = holdResponses()
    const origin = (n: number) => `https://idp${n}.example.com/`
    const started = Array.from({ length: each }, () => sendSsoRequest(publicRequest(origin(0))))
    await vi.waitFor(() => expect(pending).toHaveLength(each))
    expect(await immediately(sendSsoRequest(publicRequest(origin(0))))).toBe('busy')
    expect(network.lookup).toHaveBeenCalledTimes(each)
    // Other origins still proceed until the process-wide limit.
    for (let n = 1; started.length < total; n += 1)
      for (let i = 0; i < each && started.length < total; i += 1)
        started.push(sendSsoRequest(publicRequest(origin(n))))
    await vi.waitFor(() => expect(pending).toHaveLength(total))
    expect(await immediately(sendSsoRequest(publicRequest(origin(99))))).toBe('busy')
    for (const release of pending.splice(0)) release()
    await Promise.all(started)
    // Completed requests free their slots.
    respond(network.request)
    expect((await sendSsoRequest(publicRequest(origin(0)))).status).toBe(200)
  })

  it('frees the slot of a refused or failed request', async () => {
    network.lookup.mockResolvedValue([answer('10.0.0.1')])
    for (let i = 0; i < SSO_TRANSPORT_LIMITS.ssoMaximumConcurrentRequestsPerOrigin + 2; i += 1)
      expect(await refusal(sendSsoRequest(publicRequest()))).toBe('destination_refused')
    network.lookup.mockRejectedValue(new Error('synthetic'))
    for (let i = 0; i < SSO_TRANSPORT_LIMITS.ssoMaximumConcurrentRequestsPerOrigin + 2; i += 1)
      expect(await refusal(sendSsoRequest(publicRequest()))).toBe('dns_failed')
  })
})
