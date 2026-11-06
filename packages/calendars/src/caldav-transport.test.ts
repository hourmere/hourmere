import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }))
vi.mock('node:https', () => ({ request: network.request }))

import { parseWebhookPrivateTargets } from '@hourmere/webhooks/private-targets'
import { sendCalDav } from './caldav-transport.ts'

const input = () => ({
  url: 'https://dav.example.com/',
  body: '<propfind/>',
  authorization: 'Basic mock',
  depth: '0' as const,
  signal: new AbortController().signal,
  privateTargets: [],
})
afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
function reply(body = 'ok', status = 207) {
  network.request.mockImplementation((_url, _options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void }
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & {
        headers: object
        statusCode: number
        destroy: () => void
      }
      Object.assign(res, { headers: {}, statusCode: status, destroy: vi.fn() })
      callback(res)
      res.emit('data', Buffer.from(body))
      res.emit('end')
    }
    return req
  })
}
describe('CalDAV pinned transport', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.100.100.200',
    'fe80::1',
    '::ffff:127.0.0.1',
    'fd00:ec2::254',
  ])('rejects DNS special-use address %s', async (address) => {
    network.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }])
    await expect(sendCalDav(input())).rejects.toMatchObject({ code: 'destination_refused' })
    expect(network.request).not.toHaveBeenCalled()
  })
  it('rejects mixed public/private DNS rather than choosing a safe answer', async () => {
    network.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ])
    await expect(sendCalDav(input())).rejects.toMatchObject({ code: 'destination_refused' })
  })
  it('pins approved DNS with TLS checks and no pooled/proxy request', async () => {
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    reply()
    expect(await sendCalDav(input())).toEqual({ status: 207, body: 'ok', location: undefined })
    const options = network.request.mock.calls[0]?.[1]
    expect(options).toMatchObject({
      method: 'PROPFIND',
      agent: false,
      rejectUnauthorized: true,
      servername: 'dav.example.com',
      family: 4,
      maxHeaderSize: 16384,
    })
    const callback = vi.fn()
    options.lookup('dav.example.com', {}, callback)
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4)
    expect(network.lookup).toHaveBeenCalledTimes(1)
  })
  it('permits exact operator private destination and refuses metadata even with host allowlist', async () => {
    const privateTargets = parseWebhookPrivateTargets('dav.internal:443')
    network.lookup.mockResolvedValue([{ address: '10.0.0.2', family: 4 }])
    reply()
    await expect(
      sendCalDav({ ...input(), url: 'https://dav.internal', privateTargets }),
    ).resolves.toMatchObject({ status: 207 })
    network.lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
    await expect(
      sendCalDav({ ...input(), url: 'https://dav.internal', privateTargets }),
    ).rejects.toMatchObject({ code: 'destination_refused' })
  })
  it('rejects oversized response and never returns provider network errors', async () => {
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    reply('x'.repeat(1_048_577))
    await expect(sendCalDav(input())).rejects.toMatchObject({ code: 'invalid_response' })
    network.lookup.mockRejectedValue(Error('secret'))
    await expect(sendCalDav(input())).rejects.toMatchObject({ message: 'CalDAV transport_failed' })
  })
  it('interrupts stalled DNS on cancellation', async () => {
    network.lookup.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    const promise = sendCalDav({ ...input(), signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ code: 'timeout' })
    expect(network.request).not.toHaveBeenCalled()
  })
  it('does not let private CIDR allowlist enable public custom ports', async () => {
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    const privateTargets = parseWebhookPrivateTargets('10.0.0.0/8:8443')
    await expect(
      sendCalDav({ ...input(), url: 'https://dav.example.com:8443/', privateTargets }),
    ).rejects.toMatchObject({ code: 'destination_refused' })
    expect(network.request).not.toHaveBeenCalled()
  })
  it.each(
    [
      [],
      Array.from({ length: 33 }, () => ({ address: '8.8.8.8', family: 4 })),
      [{ address: '8.8.8.8', family: 6 }],
    ].map((addresses) => ({ addresses })),
  )('rejects empty/excess/mismatched DNS candidates', async ({ addresses }) => {
    network.lookup.mockResolvedValue(addresses)
    await expect(sendCalDav(input())).rejects.toMatchObject({ code: 'destination_refused' })
    expect(network.request).not.toHaveBeenCalled()
  })
  it('enforces the ten-second absolute DNS deadline', async () => {
    vi.useFakeTimers()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const c = new AbortController()
      setTimeout(() => c.abort(), ms)
      return c.signal
    })
    network.lookup.mockReturnValue(new Promise(() => {}))
    const assertion = expect(sendCalDav(input())).rejects.toMatchObject({ code: 'timeout' })
    expect(timeout).toHaveBeenCalledWith(10000)
    await vi.advanceTimersByTimeAsync(10000)
    await assertion
  })
  it('enforces the same absolute deadline while a response body stalls', async () => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const c = new AbortController()
      setTimeout(() => c.abort(), ms)
      return c.signal
    })
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    network.request.mockImplementation((_url, options, callback) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void }
      req.end = () => {
        callback(Object.assign(new EventEmitter(), { headers: {}, statusCode: 207 }))
        options.signal.addEventListener('abort', () => req.emit('error', Error('abort')))
      }
      return req
    })
    const assertion = expect(sendCalDav(input())).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(10000)
    await assertion
  })
})
