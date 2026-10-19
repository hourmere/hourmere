import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), httpRequest: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }))
vi.mock('node:https', () => ({ request: network.request }))
vi.mock('node:http', () => ({ request: network.httpRequest }))

import { parseWebhookPrivateTargets } from './private-targets.ts'
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

const privateTargets = parseWebhookPrivateTargets(
  'n8n:5678,localhost:80,192.168.1.0/24:8080-8081,127.0.0.1:9000,[fd12::/64]:8443',
)
describe('allowlisted private webhook URL syntax', () => {
  it.each([
    'http://n8n:5678/webhook/booking',
    'https://n8n:5678/webhook/booking',
    'http://localhost/hook',
    'http://localhost:80/hook',
    'http://192.168.1.0:8080/hook',
    'http://192.168.1.255:8081/hook',
    'http://127.0.0.1:9000/hook',
    'https://[fd12::1]:8443/hook',
    'http://crm.internal:8080/hook',
  ])('accepts %s only with a matching configured target', (value) => {
    expect(webhookUrl(value)).toBeUndefined()
    expect(webhookUrl(value, privateTargets)).toBe(new URL(value).toString())
    expect(network.lookup).not.toHaveBeenCalled()
  })
  it.each([
    'http://n8n:5679/hook',
    'http://other-n8n:5678/hook',
    'http://n8n.attacker.com:5678/hook',
    'http://n8n.:5678/hook',
    'http://crm.internal.:8080/hook',
    'http://n8n/hook',
    'http://192.168.0.255:8080/hook',
    'http://192.168.2.0:8080/hook',
    'http://192.168.1.1:8079/hook',
    'http://192.168.1.1:8082/hook',
    'http://8.8.8.8:8080/hook',
    'http://169.254.169.254:8080/hook',
    'http://100.100.100.200:8080/hook',
    'http://[fd00:ec2::254]:8443/hook',
    'ftp://n8n:5678/hook',
    'http://user:password@n8n:5678/hook',
    'http://n8n:5678/hook#credential',
    'http://n8n:5678/hook\nvalue',
    'http://n8n:5678/hook\\path',
  ])('refuses %s even when private targets are configured', (value) => {
    expect(webhookUrl(value, privateTargets)).toBeUndefined()
  })
  it('retains public HTTPS syntax when an unrelated CIDR includes its effective port', () => {
    expect(webhookUrl(input().url, parseWebhookPrivateTargets('10.0.0.0/8:443'))).toBe(input().url)
  })
  it('normalizes hostname case without changing the trusted destination', () => {
    expect(webhookUrl('http://N8N:5678/hook?version=1', privateTargets)).toBe(
      'http://n8n:5678/hook?version=1',
    )
  })
})

function privateInput(url = 'http://n8n:5678/receive') {
  return { ...input(), url, privateTargets }
}
function respondHttp(statusCode = 204) {
  network.httpRequest.mockImplementation((_url, _options, response) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void }
    req.end = () => response({ statusCode, destroy: vi.fn() })
    return req
  })
}
describe('pinned private webhook transport', () => {
  it.each([
    '169.254.169.254',
    '169.254.0.0',
    '169.254.255.255',
    '100.100.100.200',
    'fd00:ec2::254',
    'fd00:ec2::',
    'fd00:ec2::255',
    'fd00:ec2:ffff:ffff:ffff:ffff:ffff:ffff',
    'fd20:ce::254',
    'fd20:00ce:0:0:0:0:0:0254',
    'fd00:c1::a9fe:a9fe',
    'fd00:00c1:0:0:0:0:a9fe:a9fe',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '64:ff9b::169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::169.254.169.254',
    '64:ff9b:1::a9fe:a9fe',
    '::ffff:100.100.100.200',
    '::ffff:6464:64c8',
    '64:ff9b::100.100.100.200',
    '64:ff9b::6464:64c8',
    '64:ff9b:1::100.100.100.200',
    '64:ff9b:1::6464:64c8',
  ])('refuses cloud metadata DNS answer %s before opening a socket', async (address) => {
    network.lookup.mockResolvedValue([
      { address: '192.168.1.10', family: 4 },
      { address, family: address.includes(':') ? 6 : 4 },
    ])
    respondHttp()
    await expect(sendWebhook(privateInput())).rejects.toThrow('refused')
    expect(network.lookup).toHaveBeenCalledExactlyOnceWith('n8n', { all: true, verbatim: true })
    expect(network.httpRequest).not.toHaveBeenCalled()
    expect(network.request).not.toHaveBeenCalled()
  })

  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', 'fd12::1', '::1'])(
    'permits an exact host entry resolving to eligible private address %s',
    async (address) => {
      network.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }])
      respondHttp()
      expect(await sendWebhook(privateInput())).toBe(204)
      expect(network.lookup).toHaveBeenCalledExactlyOnceWith('n8n', { all: true, verbatim: true })
      expect(network.httpRequest).toHaveBeenCalledOnce()
      expect(network.request).not.toHaveBeenCalled()
      const options = network.httpRequest.mock.calls[0]?.[1]
      expect(options.agent).toBe(false)
      expect(options.servername).toBe('n8n')
      expect(options.signal).toBeInstanceOf(AbortSignal)
      options.lookup('n8n', {}, (error: unknown, selected: string) => {
        expect(error).toBeNull()
        expect(selected).toBe(address)
      })
    },
  )
  it.each([
    [{ address: '8.8.8.8', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '100.100.100.200', family: 4 }],
    [{ address: 'fd00:ec2::254', family: 6 }],
    [{ address: 'fe80::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: '127.0.0.1', family: 6 }],
    [
      { address: '127.0.0.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ],
    [
      { address: '127.0.0.1', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ],
    [],
  ])('refuses a host entry with any ineligible DNS answer %j', async (...addresses) => {
    network.lookup.mockResolvedValue(addresses)
    respondHttp()
    await expect(sendWebhook(privateInput())).rejects.toThrow('refused')
    expect(network.httpRequest).not.toHaveBeenCalled()
  })
  it('re-resolves on each attempt and refuses a rebound host before opening its next socket', async () => {
    network.lookup
      .mockResolvedValueOnce([{ address: '192.168.1.10', family: 4 }])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }])
    respondHttp()
    expect(await sendWebhook(privateInput())).toBe(204)
    await expect(sendWebhook(privateInput())).rejects.toThrow('refused')
    expect(network.lookup).toHaveBeenCalledTimes(2)
    expect(network.httpRequest).toHaveBeenCalledOnce()
  })
  it('requires every DNS answer to fit one CIDR rather than combining multiple entries', async () => {
    const targets = parseWebhookPrivateTargets('192.168.1.0/24:8080,192.168.2.0/24:8080')
    network.lookup.mockResolvedValue([
      { address: '192.168.1.1', family: 4 },
      { address: '192.168.2.1', family: 4 },
    ])
    await expect(
      sendWebhook({ ...privateInput('http://crm:8080/'), privateTargets: targets }),
    ).rejects.toThrow('refused')
    expect(network.httpRequest).not.toHaveBeenCalled()
  })
  it('rejects a CIDR hostname when even one answer falls outside its boundaries', async () => {
    network.lookup.mockResolvedValue([
      { address: '192.168.1.1', family: 4 },
      { address: '192.168.2.0', family: 4 },
    ])
    await expect(sendWebhook(privateInput('http://crm:8080/'))).rejects.toThrow('refused')
    expect(network.httpRequest).not.toHaveBeenCalled()
  })
  it('accepts a CIDR hostname only when every address belongs to its network', async () => {
    network.lookup.mockResolvedValue([
      { address: '192.168.1.0', family: 4 },
      { address: '192.168.1.255', family: 4 },
    ])
    respondHttp()
    expect(await sendWebhook(privateInput('http://crm:8081/'))).toBe(204)
  })
  it('checks IP literals directly instead of trusting DNS lookup that Node bypasses', async () => {
    network.lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
    respondHttp()
    expect(await sendWebhook(privateInput('http://127.0.0.1:9000/'))).toBe(204)
    expect(network.lookup).not.toHaveBeenCalled()
    expect(network.httpRequest.mock.calls[0]?.[0].hostname).toBe('127.0.0.1')
    await expect(sendWebhook(privateInput('http://169.254.169.254:9000/'))).rejects.toThrow(
      'refused',
    )
    expect(network.httpRequest).toHaveBeenCalledOnce()
  })
  it('revalidates the current setting before retrying a formerly allowed private destination', async () => {
    network.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    respondHttp()
    expect(await sendWebhook(privateInput())).toBe(204)
    await expect(sendWebhook({ ...privateInput(), privateTargets: [] })).rejects.toThrow('refused')
    expect(network.lookup).toHaveBeenCalledOnce()
    expect(network.httpRequest).toHaveBeenCalledOnce()
  })
  it('keeps normal public DNS delivery available alongside a CIDR on port 443', async () => {
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    respondWith(204)
    expect(
      await sendWebhook({
        ...input(),
        privateTargets: parseWebhookPrivateTargets('10.0.0.0/8:443'),
      }),
    ).toBe(204)
  })
  it('uses TLS for allowlisted HTTPS targets', async () => {
    network.lookup.mockResolvedValue([{ address: '192.168.1.10', family: 4 }])
    respondWith(204)
    expect(await sendWebhook(privateInput('https://n8n:5678/'))).toBe(204)
    expect(network.request.mock.calls[0]?.[1].rejectUnauthorized).toBe(true)
    expect(network.httpRequest).not.toHaveBeenCalled()
  })
  it('does not follow a private HTTP redirect or consume its body', async () => {
    network.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const discard = vi.fn()
    network.httpRequest.mockImplementation((_url, _options, response) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void }
      req.end = () =>
        response({
          statusCode: 302,
          headers: { location: 'http://169.254.169.254/' },
          destroy: discard,
        })
      return req
    })
    expect(await sendWebhook(privateInput())).toBe(302)
    expect(network.httpRequest).toHaveBeenCalledOnce()
    expect(discard).toHaveBeenCalledOnce()
  })
})

describe('authoritative exact-host private policy', () => {
  it('refuses a dotted HTTPS host rebinding from private to public despite public URL syntax', async () => {
    const request = {
      ...input(),
      url: 'https://hooks.example.com/receive',
      privateTargets: parseWebhookPrivateTargets('hooks.example.com:443'),
    }
    network.lookup
      .mockResolvedValueOnce([{ address: '192.168.1.10', family: 4 }])
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    respondWith(204)
    expect(await sendWebhook(request)).toBe(204)
    await expect(sendWebhook(request)).rejects.toThrow('refused')
    expect(network.lookup).toHaveBeenCalledTimes(2)
    expect(network.request).toHaveBeenCalledOnce()
  })
})

describe('private DNS result validation', () => {
  it.each([null, {}, { length: 1 }, undefined])(
    'refuses malformed DNS results %j',
    async (result) => {
      network.lookup.mockResolvedValue(result)
      await expect(sendWebhook(privateInput())).rejects.toThrow('refused')
      expect(network.httpRequest).not.toHaveBeenCalled()
    },
  )
  it('caps private DNS results before opening a socket', async () => {
    network.lookup.mockResolvedValue(
      Array.from({ length: 33 }, () => ({ address: '127.0.0.1', family: 4 })),
    )
    await expect(sendWebhook(privateInput())).rejects.toThrow('refused')
    expect(network.httpRequest).not.toHaveBeenCalled()
  })
  it('sanitizes DNS failures for allowlisted hostnames', async () => {
    network.lookup.mockRejectedValue(new Error('synthetic private DNS failure details'))
    await expect(sendWebhook(privateInput())).rejects.toThrow(/^Webhook DNS lookup failed$/)
    expect(network.httpRequest).not.toHaveBeenCalled()
  })
})
