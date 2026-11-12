import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer, type RequestOptions, type Server } from 'node:https'
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { inspect } from 'node:util'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The synthetic public answer. The harness below sends its socket to the owned loopback
// listener instead; every other pinned address must already be loopback.
const PUBLIC_ANSWER = '8.8.8.8'
const local = vi.hoisted(() => ({ port: 0, ca: '', lookup: vi.fn(), pinned: [] as string[] }))
vi.mock('node:dns/promises', () => ({ lookup: local.lookup }))
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>()
  return {
    ...actual,
    // Only the trusted test CA changes, and for a default-port (public) URL the TCP port
    // and the public answer's route. Node still uses the transport's own pinned lookup
    // callback, family, TLS name verification and HTTP parser.
    request: (url: URL, options: RequestOptions, response: (res: IncomingMessage) => void) => {
      const pinnedLookup = options.lookup
      if (!pinnedLookup) throw new Error('Socket test requires the pinned lookup')
      const publicRoute = url.port === ''
      return actual.request(
        url,
        {
          ...options,
          ...(publicRoute && { port: local.port }),
          ca: local.ca,
          lookup: (host, lookupOptions, callback) =>
            pinnedLookup(host, lookupOptions, (error, address, family) => {
              local.pinned.push(String(address))
              if (error) callback(error, address, family)
              else if (address === '127.0.0.1') callback(null, address, family)
              else if (publicRoute && address === PUBLIC_ANSWER) callback(null, '127.0.0.1', 4)
              // Fail closed if a regression ever reaches for another address.
              else callback(new Error('Socket test refused a nonlocal address'), '', 4)
            }),
        },
        response,
      )
    },
  }
})

import { SSO_TRANSPORT_LIMITS, SsoTransportError, sendSsoRequest } from './sso.ts'
import { parseSsoPrivateTargets } from './sso-private-targets.ts'

const realTimeout = AbortSignal.timeout.bind(AbortSignal)
const MAX = SSO_TRANSPORT_LIMITS.ssoMaximumResponseBytes
const PUBLIC_HOST = 'idp.sso-fixture.com'
const PRIVATE_HOST = 'idp.sso-fixture.internal'
const OTHER_HOST = 'other.sso-fixture.internal'

let directory: string
let key: string
let server: Server
let stall: TcpServer
let plain: HttpServer
let stallPort: number
let plainPort: number
let requests: number
let observed: IncomingMessage[]
let handler: (req: IncomingMessage, res: ServerResponse) => void
let timers: NodeJS.Timeout[]
let stalled: Socket[]
let consoleCalls: unknown[][]

const listen = (target: Server | TcpServer | HttpServer) =>
  new Promise<number>((resolve) =>
    target.listen(0, '127.0.0.1', () => {
      const address = target.address()
      if (!address || typeof address === 'string') throw new Error('Missing loopback port')
      resolve(address.port)
    }),
  )

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hourmere-sso-tls-'))
  const keyPath = join(directory, 'server.key')
  const certificatePath = join(directory, 'server.crt')
  // An ephemeral test identity; no private key or credential is committed.
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
      '-days',
      '1',
      '-subj',
      `/CN=${PUBLIC_HOST}`,
      '-addext',
      `subjectAltName=DNS:${PUBLIC_HOST},DNS:${PRIVATE_HOST},IP:127.0.0.1`,
    ],
    { stdio: 'ignore' },
  )
  ;[key, local.ca] = await Promise.all([
    readFile(keyPath, 'utf8'),
    readFile(certificatePath, 'utf8'),
  ])
})

beforeEach(async () => {
  requests = 0
  observed = []
  timers = []
  stalled = []
  local.pinned = []
  local.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
  handler = (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  server = createServer({ key, cert: local.ca }, (req, res) => {
    requests += 1
    observed.push(req)
    handler(req, res)
  })
  local.port = await listen(server)
  // Accepts TCP and never answers the TLS handshake.
  stall = createTcpServer((socket) => stalled.push(socket))
  stallPort = await listen(stall)
  plain = createHttpServer((req, res) => {
    requests += 1
    observed.push(req)
    handler(req, res)
  })
  plainPort = await listen(plain)
  consoleCalls = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, method).mockImplementation((...args) => consoleCalls.push(args))
})

afterEach(async () => {
  for (const timer of timers) clearInterval(timer)
  for (const socket of stalled) socket.destroy()
  const closing = [server, plain].map(
    (target) =>
      new Promise<void>((resolve, reject) =>
        target.close((error) => (error ? reject(error) : resolve())),
      ),
  )
  server.closeAllConnections()
  plain.closeAllConnections()
  await Promise.all([...closing, new Promise<void>((resolve) => stall.close(() => resolve()))])
  // The profile never logs, whatever the outcome.
  expect(consoleCalls).toEqual([])
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

const targets = () =>
  parseSsoPrivateTargets(
    `${PRIVATE_HOST}:${local.port},${OTHER_HOST}:${local.port},stall.sso-fixture.internal:${stallPort},127.0.0.1:${local.port},localhost:${plainPort}`,
  )
const privateUrl = (path = '/realm/.well-known/openid-configuration', host = PRIVATE_HOST) =>
  `https://${host}:${local.port}${path}`

async function failure(promise: Promise<unknown>): Promise<SsoTransportError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SsoTransportError)
    return error as SsoTransportError
  }
  throw new Error('expected the SSO transport to fail')
}

/** Deadlines short enough for a test; the code still asks for its pinned values. */
function shortDeadlines({ connect, response }: { connect?: number; response?: number }) {
  return vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((ms) =>
      ms === SSO_TRANSPORT_LIMITS.ssoConnectTimeout
        ? connect === undefined
          ? new AbortController().signal
          : realTimeout(connect)
        : response === undefined
          ? new AbortController().signal
          : realTimeout(response),
    )
}

describe('pinned SSO transport over real loopback sockets', () => {
  it('connects to the validated public answer with TLS verifying the original hostname', async () => {
    local.lookup.mockResolvedValue([{ address: PUBLIC_ANSWER, family: 4 }])
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ issuer: `https://${PUBLIC_HOST}`, path: req.url }))
    }
    const response = await sendSsoRequest({
      url: `https://${PUBLIC_HOST}/.well-known/openid-configuration?tenant=a`,
      privateTargets: [],
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body.toString())).toEqual({
      issuer: `https://${PUBLIC_HOST}`,
      path: '/.well-known/openid-configuration?tenant=a',
    })
    expect(local.pinned).toEqual([PUBLIC_ANSWER])
    expect(local.lookup).toHaveBeenCalledExactlyOnceWith(PUBLIC_HOST, { all: true, verbatim: true })
    const [req] = observed
    if (!req) throw new Error('Missing request')
    expect(req.method).toBe('GET')
    expect(req.headers.host).toBe(`${PUBLIC_HOST}:${local.port}`)
    expect((req.socket as TLSSocket).servername).toBe(PUBLIC_HOST)
    expect(req.headers['user-agent']).toBe('Hourmere-SSO/1')
    expect(req.headers['accept-encoding']).toBe('gzip')
    expect(req.headers.cookie).toBeUndefined()
  })

  it('never asks the resolver again at connect time, so a rebinding answer is never used', async () => {
    // Validation sees a public answer; every later resolution would be private.
    local.lookup
      .mockResolvedValueOnce([{ address: PUBLIC_ANSWER, family: 4 }])
      .mockResolvedValue([{ address: '10.0.0.1', family: 4 }])
    const request = { url: `https://${PUBLIC_HOST}/jwks`, privateTargets: [] }
    expect((await sendSsoRequest(request)).status).toBe(200)
    expect(local.pinned).toEqual([PUBLIC_ANSWER])
    expect(local.lookup).toHaveBeenCalledOnce()
    expect(requests).toBe(1)
    // The next request resolves again and refuses the private answer before any socket.
    expect((await failure(sendSsoRequest(request))).code).toBe('destination_refused')
    expect(local.lookup).toHaveBeenCalledTimes(2)
    expect(local.pinned).toEqual([PUBLIC_ANSWER])
    expect(requests).toBe(1)
  })

  it('reaches an exactly listed private host over verified HTTPS', async () => {
    const response = await sendSsoRequest({ url: privateUrl(), privateTargets: targets() })
    expect(response.status).toBe(200)
    expect(local.pinned).toEqual(['127.0.0.1'])
    expect((observed[0]?.socket as TLSSocket | undefined)?.servername).toBe(PRIVATE_HOST)
    expect(observed[0]?.headers.host).toBe(`${PRIVATE_HOST}:${local.port}`)
  })

  it('verifies an IP literal target against the certificate address', async () => {
    const response = await sendSsoRequest({
      url: `https://127.0.0.1:${local.port}/jwks`,
      privateTargets: targets(),
    })
    expect(response.status).toBe(200)
    expect(local.lookup).not.toHaveBeenCalled()
  })

  it.each([
    ['a listed private host', () => privateUrl('/', OTHER_HOST), [] as string[]],
    ['a public host', () => 'https://other.sso-fixture.com/', [PUBLIC_ANSWER]],
  ])(
    'refuses a trusted certificate for another name at %s before sending HTTP',
    async (_, url, answers) => {
      if (answers.length)
        local.lookup.mockResolvedValue(answers.map((address) => ({ address, family: 4 })))
      expect((await failure(sendSsoRequest({ url: url(), privateTargets: targets() }))).code).toBe(
        'transport_failed',
      )
      expect(requests).toBe(0)
    },
  )

  it('refuses a different port, plain HTTP and an empty allowlist without a socket', async () => {
    for (const request of [
      { url: `https://${PRIVATE_HOST}:${local.port + 1}/`, privateTargets: targets() },
      { url: `http://${PRIVATE_HOST}:${local.port}/`, privateTargets: targets() },
      { url: privateUrl(), privateTargets: [] },
      { url: privateUrl(), privateTargets: parseSsoPrivateTargets('') },
    ])
      expect((await failure(sendSsoRequest(request))).code).toBe('destination_refused')
    expect(local.lookup).not.toHaveBeenCalled()
    expect(requests).toBe(0)
  })

  it('ignores proxy environment variables', async () => {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy'])
      vi.stubEnv(name, `http://127.0.0.1:${plainPort}/must-not-be-a-proxy`)
    expect((await sendSsoRequest({ url: privateUrl(), privateTargets: targets() })).status).toBe(
      200,
    )
    expect(observed.map((req) => req.url)).toEqual(['/realm/.well-known/openid-configuration'])
    // A proxy would have received a CONNECT or an absolute-form request on the plain server.
    expect(observed.map((req) => req.method)).toEqual(['GET'])
    expect(requests).toBe(1)
  })
})

describe('SSO redirects', () => {
  it.each([301, 302, 303, 307, 308])(
    'refuses a %i and never contacts its location',
    async (status) => {
      handler = (_req, res) =>
        res.writeHead(status, { location: privateUrl('/second') }).end('moved')
      expect(
        (await failure(sendSsoRequest({ url: privateUrl(), privateTargets: targets() }))).code,
      ).toBe('redirect_refused')
      expect(requests).toBe(1)
      expect(local.lookup).toHaveBeenCalledOnce()
      expect(observed.map((req) => req.url)).toEqual(['/realm/.well-known/openid-configuration'])
    },
  )
})

describe('SSO response size and decompression', () => {
  const fetch = () => sendSsoRequest({ url: privateUrl(), privateTargets: targets() })

  it('accepts a body of exactly the maximum size', async () => {
    handler = (_req, res) => res.writeHead(200).end(Buffer.alloc(MAX, 'x'))
    expect((await fetch()).body.length).toBe(MAX)
  })

  it('refuses a declared length above the maximum', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': String(MAX + 1) })
      res.end(Buffer.alloc(MAX + 1, 'x'))
    }
    expect((await failure(fetch())).code).toBe('response_too_large')
  })

  it('refuses an undeclared streamed body once it passes the maximum', async () => {
    handler = (_req, res) => {
      res.writeHead(200)
      for (let i = 0; i < 4; i += 1) res.write(Buffer.alloc(MAX / 2, 'x'))
      res.end()
    }
    expect((await failure(fetch())).code).toBe('response_too_large')
  })

  it('bounds the bytes on the wire even when they decode to nothing', async () => {
    // Concatenated empty gzip members: about 1.2 MiB on the wire, zero bytes decoded.
    const member = gzipSync(Buffer.alloc(0))
    const members = Buffer.concat(
      Array.from({ length: Math.ceil((MAX * 1.2) / member.length) }, () => member),
    )
    handler = (_req, res) => res.writeHead(200, { 'content-encoding': 'gzip' }).end(members)
    expect((await failure(fetch())).code).toBe('response_too_large')
  })

  it('decodes gzip bodies up to exactly the maximum', async () => {
    const json = Buffer.from(JSON.stringify({ keys: [{ kid: 'synthetic' }] }))
    const full = Buffer.alloc(MAX, 'x')
    for (const [encoding, body, expected] of [
      ['gzip', gzipSync(json), json],
      ['x-gzip', gzipSync(json), json],
      ['gzip', gzipSync(full), full],
    ] as const) {
      handler = (_req, res) => res.writeHead(200, { 'content-encoding': encoding }).end(body)
      expect((await fetch()).body.equals(expected)).toBe(true)
    }
  })

  it('stops a gzip decompression bomb at the maximum decoded size', async () => {
    const body = gzipSync(Buffer.alloc(64 * MAX))
    expect(body.length).toBeLessThan(MAX / 4)
    handler = (_req, res) => res.writeHead(200, { 'content-encoding': 'gzip' }).end(body)
    const started = performance.now()
    expect((await failure(fetch())).code).toBe('response_too_large')
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('refuses a Brotli body without decoding it, however small', async () => {
    // Its decoder could reserve a window of up to 16 MiB before any byte is counted.
    handler = (_req, res) =>
      res.writeHead(200, { 'content-encoding': 'br' }).end(brotliCompressSync(Buffer.from('{}')))
    expect((await failure(fetch())).code).toBe('unsupported_encoding')
  })

  it('refuses a corrupt compressed body', async () => {
    handler = (_req, res) =>
      res.writeHead(200, { 'content-encoding': 'gzip' }).end(Buffer.from('not gzip at all'))
    expect((await failure(fetch())).code).toBe('transport_failed')
  })
})

describe('SSO connection and body deadlines', () => {
  const fetch = (url = privateUrl()) => sendSsoRequest({ url, privateTargets: targets() })

  it('stops a TLS handshake that never completes at the connection deadline', async () => {
    const timeout = shortDeadlines({ connect: 200 })
    const started = performance.now()
    expect((await failure(fetch(`https://stall.sso-fixture.internal:${stallPort}/`))).code).toBe(
      'connect_timeout',
    )
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(stalled.length).toBe(1)
    expect(timeout).toHaveBeenCalledWith(SSO_TRANSPORT_LIMITS.ssoConnectTimeout)
  })

  it('stops a DNS lookup that never answers at the connection deadline', async () => {
    shortDeadlines({ connect: 100 })
    local.lookup.mockImplementation(() => new Promise(() => {}))
    expect((await failure(fetch())).code).toBe('connect_timeout')
    expect(requests).toBe(0)
  })

  it('ends the connection deadline once TLS is established', async () => {
    shortDeadlines({ connect: 1_000 })
    handler = (_req, res) => {
      res.writeHead(200)
      timers.push(setTimeout(() => res.end('{"late":true}'), 1_500))
    }
    expect((await fetch()).body.toString()).toBe('{"late":true}')
  })

  it('stops a server that sends headers and then no body', async () => {
    const timeout = shortDeadlines({ response: 1_000 })
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.flushHeaders()
    }
    expect((await failure(fetch())).code).toBe('timeout')
    expect(timeout).toHaveBeenCalledWith(SSO_TRANSPORT_LIMITS.ssoResponseTimeout)
  })

  it('stops a slow-loris body that keeps trickling below the size limit', async () => {
    shortDeadlines({ response: 1_500 })
    let written = 0
    handler = (_req, res) => {
      res.writeHead(200)
      res.flushHeaders()
      timers.push(
        setInterval(() => {
          if (res.writableEnded || res.destroyed) return
          res.write('x')
          written += 1
        }, 20),
      )
    }
    const started = performance.now()
    expect((await failure(fetch())).code).toBe('timeout')
    expect(written).toBeGreaterThan(3)
    expect(performance.now() - started).toBeLessThan(6_000)
  }, 15_000)

  it('stops a server that never sends headers', async () => {
    shortDeadlines({ response: 2_000 })
    handler = () => {}
    expect((await failure(fetch())).code).toBe('timeout')
    expect(requests).toBe(1)
  })
})

describe('SSO secret redaction', () => {
  const secrets = [
    'synthetic-access-token-7f3a',
    'synthetic-client-secret-91c2',
    'synthetic-authorization-code-55d0',
    'synthetic-query-state-3b8e',
    'synthetic-provider-description-a1f4',
    'synthetic-assertion-xml-0c9d',
  ]
  const tokenRequest = (url = privateUrl('/token?state=synthetic-query-state-3b8e')) => ({
    url,
    method: 'POST' as const,
    headers: {
      authorization: 'Bearer synthetic-access-token-7f3a',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'client_secret=synthetic-client-secret-91c2&code=synthetic-authorization-code-55d0',
    privateTargets: targets(),
  })
  const providerBody =
    '{"error":"invalid_grant","error_description":"synthetic-provider-description-a1f4","saml":"<Assertion>synthetic-assertion-xml-0c9d</Assertion>"}'

  function expectRedacted(error: SsoTransportError) {
    const renderings = [
      inspect(error, { depth: Number.POSITIVE_INFINITY, showHidden: true }),
      String(error),
      error.stack ?? '',
      JSON.stringify(error),
      error.message,
    ].join('\n')
    for (const secret of secrets) expect(renderings).not.toContain(secret)
    expect(renderings).not.toContain('sso-fixture')
    expect(error.message).toBe(`SSO transport ${error.code}`)
    expect(error.cause).toBeUndefined()
  }

  it.each<[string, (req: IncomingMessage, res: ServerResponse) => void, string]>([
    [
      'a redirect carrying the token',
      (_req, res) =>
        res
          .writeHead(302, {
            location: `${privateUrl('/next')}?access_token=synthetic-access-token-7f3a`,
          })
          .end(providerBody),
      'redirect_refused',
    ],
    [
      'a connection cut in the middle of the body',
      (_req, res) => {
        res.writeHead(500, { 'content-length': '100000' })
        res.write(providerBody)
        setImmediate(() => res.socket?.destroy())
      },
      'transport_failed',
    ],
    [
      'an oversized error body',
      (_req, res) =>
        res.writeHead(400).end(providerBody.repeat(Math.ceil(MAX / providerBody.length) + 1)),
      'response_too_large',
    ],
    [
      'an unsupported coding',
      (_req, res) => res.writeHead(400, { 'content-encoding': 'deflate' }).end(providerBody),
      'unsupported_encoding',
    ],
  ])('keeps secrets and provider text out of the error for %s', async (_, respond, code) => {
    handler = (req, res) => {
      req.resume()
      respond(req, res)
    }
    const error = await failure(sendSsoRequest(tokenRequest()))
    expect(error.code).toBe(code)
    expectRedacted(error)
  })

  it('keeps secrets out of a TLS name failure and a timeout', async () => {
    expectRedacted(await failure(sendSsoRequest(tokenRequest(privateUrl('/token', OTHER_HOST)))))
    shortDeadlines({ response: 200 })
    handler = () => {}
    expectRedacted(await failure(sendSsoRequest(tokenRequest())))
  })

  it('returns a provider error body to the caller without logging it', async () => {
    handler = (req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () =>
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(body.includes('synthetic-client-secret-91c2') ? providerBody : '{}'),
      )
    }
    const response = await sendSsoRequest(tokenRequest())
    expect(response.status).toBe(400)
    expect(response.body.toString()).toBe(providerBody)
    expect(observed[0]?.headers.authorization).toBe('Bearer synthetic-access-token-7f3a')
  })
})

describe('separately acknowledged loopback HTTP trial over a real socket', () => {
  it('uses plain HTTP only for the acknowledged, listed loopback name', async () => {
    const url = `http://localhost:${plainPort}/realms/trial/.well-known/openid-configuration`
    expect((await failure(sendSsoRequest({ url, privateTargets: targets() }))).code).toBe(
      'destination_refused',
    )
    expect(requests).toBe(0)
    const response = await sendSsoRequest({
      url,
      privateTargets: targets(),
      loopbackHttpTrial: true,
    })
    expect(response.status).toBe(200)
    expect(observed[0]?.headers.host).toBe(`localhost:${plainPort}`)
    expect(local.lookup).toHaveBeenCalledExactlyOnceWith('localhost', {
      all: true,
      verbatim: true,
    })
  })
})
