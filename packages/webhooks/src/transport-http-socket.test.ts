import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dns = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }))

import { webhookSignature } from './crypto.ts'
import { parseWebhookPrivateTargets } from './private-targets.ts'
import { sendWebhook } from './transport.ts'

let server: Server
let port: number
let requests: number
let receiver: (req: IncomingMessage, res: ServerResponse) => void

beforeEach(async () => {
  requests = 0
  receiver = (_req, res) => res.writeHead(204).end()
  server = createServer((req, res) => {
    requests += 1
    receiver(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback port')
  port = address.port
  dns.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
})

afterEach(async () => {
  const closed = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  server.closeAllConnections()
  await closed
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

function input(host = '127.0.0.1') {
  const body = '{"event":"booking.created","synthetic":true}'
  const timestamp = '2026-10-19T12:00:00.000Z'
  return {
    url: `http://${host}:${port}/webhook/booking?version=1`,
    body,
    signal: new AbortController().signal,
    privateTargets: parseWebhookPrivateTargets(`${host}:${port}`),
    headers: {
      'webhook-id': 'synthetic-delivery',
      'webhook-timestamp': timestamp,
      'webhook-signature': webhookSignature('synthetic-unit-test-key', timestamp, body),
    },
  }
}

describe('allowlisted webhook HTTP over an owned loopback socket', () => {
  it.each(['127.0.0.1', 'n8n'])(
    'delivers a signed JSON POST through %s and pins DNS without using proxy environment',
    async (host) => {
      const observed: {
        body: string
        url?: string
        method?: string
        signatureValid: boolean
        headersValid: boolean
        host?: string
      } = {
        body: '',
        signatureValid: false,
        headersValid: false,
      }
      vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${port}/must-not-be-a-proxy`)
      vi.stubEnv('HTTPS_PROXY', `http://127.0.0.1:${port}/must-not-be-a-proxy`)
      vi.stubEnv('ALL_PROXY', `http://127.0.0.1:${port}/must-not-be-a-proxy`)
      const request = input(host)
      receiver = (req, res) => {
        observed.host = req.headers.host
        observed.method = req.method
        observed.url = req.url
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => {
          observed.body += chunk
        })
        req.on('end', () => {
          observed.signatureValid =
            req.headers['webhook-signature'] ===
            webhookSignature(
              'synthetic-unit-test-key',
              request.headers['webhook-timestamp'],
              observed.body,
            )
          observed.headersValid =
            req.headers['webhook-id'] === request.headers['webhook-id'] &&
            req.headers['webhook-timestamp'] === request.headers['webhook-timestamp'] &&
            req.headers['content-type'] === 'application/json' &&
            req.headers['user-agent'] === 'Hourmere-Webhooks/1'
          res.writeHead(204).end()
        })
      }
      await expect(sendWebhook(request)).resolves.toBe(204)
      expect(observed).toEqual({
        body: request.body,
        url: '/webhook/booking?version=1',
        method: 'POST',
        signatureValid: true,
        headersValid: true,
        host: `${host}:${port}`,
      })
      expect(requests).toBe(1)
      expect(dns.lookup).toHaveBeenCalledTimes(host === 'n8n' ? 1 : 0)
    },
  )
  it('puts the signed headers first and the fixed headers after them on the wire', async () => {
    let raw: string[] = []
    receiver = (req, res) => {
      raw = req.rawHeaders
      req.resume()
      req.on('end', () => res.writeHead(204).end())
    }
    const request = input()
    await expect(sendWebhook(request)).resolves.toBe(204)
    // Node appends Host and Connection itself; the transport decides the first six.
    expect(raw.slice(0, 12)).toEqual([
      'webhook-id',
      request.headers['webhook-id'],
      'webhook-timestamp',
      request.headers['webhook-timestamp'],
      'webhook-signature',
      request.headers['webhook-signature'],
      'content-type',
      'application/json',
      'content-length',
      String(Buffer.byteLength(request.body)),
      'user-agent',
      'Hourmere-Webhooks/1',
    ])
  })
  it('keeps the fixed content type and user agent when a caller sends them in another case', async () => {
    let seen: IncomingMessage | undefined
    receiver = (req, res) => {
      seen = req
      req.resume()
      req.on('end', () => res.writeHead(204).end())
    }
    const request = input()
    await expect(
      sendWebhook({
        ...request,
        headers: {
          ...request.headers,
          'Content-Type': 'text/plain',
          'User-Agent': 'synthetic-caller/1',
        },
      }),
    ).resolves.toBe(204)
    expect(seen?.headers['content-type']).toBe('application/json')
    expect(seen?.headers['user-agent']).toBe('Hourmere-Webhooks/1')
    const names = (seen?.rawHeaders ?? []).filter((_, index) => index % 2 === 0)
    expect(names.filter((name) => /^(content-type|user-agent)$/i.test(name))).toHaveLength(2)
  })
  it('returns a redirect without sending a request to its location', async () => {
    receiver = (_req, res) =>
      res.writeHead(302, { location: `http://127.0.0.1:${port}/redirected` }).end()
    await expect(sendWebhook(input())).resolves.toBe(302)
    expect(requests).toBe(1)
  })
  it('keeps the bounded response header limit for HTTP', async () => {
    receiver = (_req, res) => res.writeHead(200, { 'x-oversized': 'x'.repeat(20_000) }).end()
    await expect(sendWebhook(input())).rejects.toThrow(/^Webhook transport failed$/)
    expect(requests).toBe(1)
  })
  it('discards response bodies as soon as acknowledgement headers arrive', async () => {
    receiver = (_req, res) => {
      res.writeHead(503)
      res.flushHeaders()
      res.write(Buffer.alloc(1_000_000, 'x'))
    }
    await expect(sendWebhook(input())).resolves.toBe(503)
    expect(requests).toBe(1)
  })
  it('uses the same deadline for HTTP sockets that never acknowledge', async () => {
    const deadline = AbortSignal.timeout(100)
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline)
    receiver = () => {}
    await expect(sendWebhook(input())).rejects.toThrow(/^Webhook transport failed$/)
    expect(timeout).toHaveBeenCalledWith(10_000)
    expect(requests).toBe(1)
  })
  it('refuses the actual literal and exact port without opening an unapproved socket', async () => {
    const request = input()
    await expect(sendWebhook({ ...request, privateTargets: [] })).rejects.toThrow('refused')
    await expect(
      sendWebhook({
        ...request,
        privateTargets: parseWebhookPrivateTargets(
          `127.0.0.1:${port === 65535 ? port - 1 : port + 1}`,
        ),
      }),
    ).rejects.toThrow('refused')
    expect(requests).toBe(0)
  })
})
