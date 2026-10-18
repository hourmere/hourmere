import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }))
vi.mock('node:https', () => ({ request: network.request }))

import { isPublicAddress, sendWebhook, webhookUrl } from './transport.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
  vi.restoreAllMocks()
})
describe('webhook destinations', () => {
  it.each([
    '127.0.0.1',
    '10.2.3.4',
    '0.0.0.0',
    '100.64.1.1',
    '169.254.169.254',
    '172.19.0.2',
    '192.168.1.2',
    '192.0.0.9',
    '192.0.2.1',
    '192.31.196.1',
    '192.52.193.1',
    '192.175.48.1',
    '2620:4f:8000::1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.1.2.3',
    '255.255.255.255',
    '::1',
    '::',
    '::ffff:8.8.8.8',
    'fc00::1',
    'fe80::1',
    '64:ff9b::808:808',
    '2001:db8::1',
    '2002:808:808::1',
    '2001::1',
    '3fff::1',
    'ff02::1',
  ])('rejects special-use address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false)
  })
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'permits public address %s',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true)
    },
  )
  it.each([
    'http://hooks.example.com/a',
    'https://127.1/a',
    'https://0x7f000001/',
    'https://[::1]/',
    'https://hooks.example.com:8443/',
    'https://user:pass@hooks.example.com/',
    'https://hooks.example.com/#secret',
    'https://localhost/',
    'https://hooks.local/',
    'https://hooks.example.com./',
    'https://hooks.example.com/\nvalue',
    'https://hooks.example.com\\@internal/',
  ])('refuses unsafe URL %s', (value) => {
    expect(webhookUrl(value)).toBeUndefined()
  })
  it('rejects malformed Unicode and URLs that expand past the stored byte limit', () => {
    expect(webhookUrl(`https://hooks.example.com/${'预约'.repeat(500)}`)).toBeUndefined()
    expect(webhookUrl(`https://hooks.example.com/${String.fromCharCode(0xd800)}`)).toBeUndefined()
  })
  it('keeps a normal HTTPS destination and its path/query exact after normalization', () => {
    expect(webhookUrl('https://Hooks.example.com:443/events?version=1')).toBe(
      'https://hooks.example.com/events?version=1',
    )
  })
})

const input = () => ({
  url: 'https://hooks.example.com/receive?credential=synthetic',
  body: '{}',
  headers: { 'webhook-id': 'test' },
  signal: new AbortController().signal,
})
function respondWith(statusCode: number) {
  network.request.mockImplementation((_url, _options, response) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void }
    req.end = () => response({ statusCode, destroy: () => {} })
    return req
  })
}
describe('pinned webhook HTTPS transport', () => {
  it.each([
    'http://hooks.example.com/receive',
    'https://hooks.example.com:8443/receive',
    'https://user:password@hooks.example.com/receive',
    'https://127.0.0.1/receive',
  ])('revalidates stored destination %s before DNS or HTTPS', async (url) => {
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    respondWith(204)
    await expect(sendWebhook({ ...input(), url })).rejects.toThrow('refused')
    expect(network.lookup).not.toHaveBeenCalled()
    expect(network.request).not.toHaveBeenCalled()
  })
  it('refuses more than 32 DNS answers before opening a socket', async () => {
    network.lookup.mockResolvedValue(
      Array.from({ length: 33 }, (_, i) => ({ address: `8.8.8.${i + 1}`, family: 4 })),
    )
    respondWith(204)
    await expect(sendWebhook(input())).rejects.toThrow('refused')
    expect(network.request).not.toHaveBeenCalled()
  })
  it('accepts exactly 32 public DNS answers', async () => {
    network.lookup.mockResolvedValue(
      Array.from({ length: 32 }, (_, i) => ({ address: `8.8.8.${i + 1}`, family: 4 })),
    )
    respondWith(204)
    expect(await sendWebhook(input())).toBe(204)
    expect(network.request).toHaveBeenCalledOnce()
  })
  it('refuses the entire DNS answer when even one candidate is private', async () => {
    network.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    await expect(sendWebhook(input())).rejects.toThrow('refused')
    expect(network.request).not.toHaveBeenCalled()
  })
  it.each([
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ])(
    'pins $address while retaining Host/SNI, TLS verification and bounded headers',
    async (selected) => {
      network.lookup.mockResolvedValue([selected])
      const discarded = vi.fn()
      network.request.mockImplementation((_url, options, response) => {
        const req = new EventEmitter() as EventEmitter & { end: () => void }
        req.end = () => response({ statusCode: 204, destroy: discarded })
        expect(options.agent).toBe(false)
        expect(options.family).toBe(selected.family)
        expect(options.servername).toBe('hooks.example.com')
        expect(options.rejectUnauthorized).toBe(true)
        expect(options.maxHeaderSize).toBe(16384)
        options.lookup('hooks.example.com', {}, (err: unknown, ip: string, family: number) => {
          expect(err).toBeNull()
          expect(ip).toBe(selected.address)
          expect(family).toBe(selected.family)
        })
        return req
      })
      expect(await sendWebhook(input())).toBe(204)
      expect(discarded).toHaveBeenCalledOnce()
      expect(network.lookup).toHaveBeenCalledOnce()
    },
  )
  it('does not follow redirect status or read any response body', async () => {
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    network.request.mockImplementation((_url, _options, response) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void }
      req.end = () =>
        response({ statusCode: 302, headers: { location: 'http://127.0.0.1/' }, destroy: () => {} })
      return req
    })
    expect(await sendWebhook(input())).toBe(302)
    expect(network.request).toHaveBeenCalledOnce()
  })
  it('enforces one ten-second deadline even while DNS has not answered', async () => {
    const timeout = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    network.lookup.mockImplementation(() => new Promise(() => {}))
    const pending = sendWebhook(input())
    const result = expect(pending).rejects.toThrow('stopped')
    expect(timeoutSpy).toHaveBeenCalledWith(10_000)
    timeout.abort()
    await result
    expect(network.request).not.toHaveBeenCalled()
  })
  it('sanitizes request errors instead of exposing credentials or response text', async () => {
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    network.request.mockImplementation(() => {
      const req = new EventEmitter() as EventEmitter & { end: () => void }
      req.end = () => req.emit('error', new Error('credential=synthetic-secret'))
      return req
    })
    await expect(sendWebhook(input())).rejects.toThrow(/^Webhook transport failed$/)
  })
})
