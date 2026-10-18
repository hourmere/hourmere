import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type RequestOptions, type Server } from 'node:https'
import { BlockList } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const local = vi.hoisted(() => ({ port: 0, ca: '', lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: local.lookup }))
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>()
  return {
    ...actual,
    // Only the TCP port and trusted test CA change. Node still uses the production
    // lookup callback, family selection, TLS name verification and HTTP parser.
    request: (url: URL, options: RequestOptions, response: (res: IncomingMessage) => void) => {
      const pinnedLookup = options.lookup
      if (!pinnedLookup) throw new Error('Loopback test requires the pinned lookup')
      return actual.request(
        url,
        {
          ...options,
          port: local.port,
          ca: local.ca,
          lookup: (host, lookupOptions, callback) =>
            pinnedLookup(host, lookupOptions, (error, address, family) => {
              // Fail closed if a future regression attempts a nonlocal socket.
              if (error || address === '127.0.0.1') callback(error, address, family)
              else callback(new Error('Loopback test refused a nonlocal address'), '', 4)
            }),
        },
        response,
      )
    },
  }
})

import { sendWebhook } from './transport.ts'

const hostname = 'hooks.transport-fixture.com'
let directory: string
let key: string
let server: Server
let requests: number
let receiver: (req: IncomingMessage, res: ServerResponse) => void

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hourmere-webhook-tls-'))
  const keyPath = join(directory, 'server.key')
  const certificatePath = join(directory, 'server.crt')
  // Generate an ephemeral test identity; no private key or credential is committed.
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
      `/CN=${hostname}`,
      '-addext',
      `subjectAltName=DNS:${hostname}`,
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
  local.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
  const check = BlockList.prototype.check
  vi.spyOn(BlockList.prototype, 'check').mockImplementation(function (
    this: BlockList,
    address,
    type,
  ) {
    // The test's synthetic DNS may resolve only to its owned loopback listener.
    if (address === '127.0.0.1' && type === 'ipv4') return false
    return check.call(this, address, type)
  })
  receiver = (_req, res) => res.writeHead(204).end()
  server = createServer({ key, cert: local.ca }, (req, res) => {
    requests += 1
    receiver(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback port')
  local.port = address.port
})

afterEach(async () => {
  const closed = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  server.closeAllConnections()
  await closed
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

const input = () => ({
  url: `https://${hostname}/receive?version=1`,
  body: '{"event":"synthetic"}',
  headers: { 'webhook-id': 'synthetic-delivery' },
  signal: new AbortController().signal,
})

describe('webhook transport over a real loopback TLS socket', () => {
  it('uses the pinned single-address lookup and original Host/SNI for a verified POST', async () => {
    const observed: { host?: string; servername?: string; url?: string; body: string } = {
      body: '',
    }
    receiver = (req, res) => {
      observed.host = req.headers.host
      observed.servername = (req.socket as TLSSocket).servername || undefined
      observed.url = req.url
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        observed.body += chunk
      })
      req.on('end', () => res.writeHead(204).end())
    }
    await expect(sendWebhook(input())).resolves.toBe(204)
    expect(requests).toBe(1)
    expect(observed).toEqual({
      host: `${hostname}:${local.port}`,
      servername: hostname,
      url: '/receive?version=1',
      body: input().body,
    })
    expect(local.lookup).toHaveBeenCalledExactlyOnceWith(hostname, { all: true, verbatim: true })
  })

  it('rejects a trusted certificate for a different hostname before sending HTTP', async () => {
    await expect(
      sendWebhook({ ...input(), url: 'https://other.transport-fixture.com/receive' }),
    ).rejects.toThrow(/^Webhook transport failed$/)
    expect(requests).toBe(0)
  })

  it('returns redirects without making a second request', async () => {
    receiver = (_req, res) =>
      res.writeHead(302, { location: `https://${hostname}/redirected` }).end()
    await expect(sendWebhook(input())).resolves.toBe(302)
    expect(requests).toBe(1)
  })

  it('rejects response headers larger than the configured limit', async () => {
    receiver = (_req, res) => res.writeHead(200, { 'x-oversized': 'x'.repeat(20_000) }).end()
    await expect(sendWebhook(input())).rejects.toThrow(/^Webhook transport failed$/)
    expect(requests).toBe(1)
  })

  it('acknowledges error headers without waiting for a large unfinished response body', async () => {
    receiver = (_req, res) => {
      res.writeHead(503)
      res.flushHeaders()
      res.write(Buffer.alloc(1_000_000, 'x'))
      // No end: waiting for this body would leave the attempt hanging until its deadline.
    }
    await expect(sendWebhook(input())).resolves.toBe(503)
    expect(requests).toBe(1)
  })

  it('aborts a socket whose receiver never sends response headers at the shared deadline', async () => {
    const deadline = AbortSignal.timeout(500)
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline)
    receiver = () => {}
    await expect(sendWebhook(input())).rejects.toThrow(/^Webhook transport failed$/)
    expect(timeout).toHaveBeenCalledWith(10_000)
    expect(requests).toBe(1)
  })
})
