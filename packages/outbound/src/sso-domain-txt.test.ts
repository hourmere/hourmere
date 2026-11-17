import { afterEach, describe, expect, it, vi } from 'vitest'

const dns = vi.hoisted(() => ({ resolveTxt: vi.fn(), cancel: vi.fn(), constructors: vi.fn() }))
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    constructor(options: unknown) {
      dns.constructors(options)
    }
    resolveTxt = dns.resolveTxt
    cancel = dns.cancel
  },
  lookup: vi.fn(() => {
    throw new Error('An ownership proof must not resolve IP addresses')
  }),
}))

import { resolveSsoDomainTxt, SSO_TRANSPORT_LIMITS } from './sso.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('guarded domain TXT lookup', () => {
  it('queries only the absolute exact TXT name and preserves record/chunk boundaries', async () => {
    dns.resolveTxt.mockResolvedValue([['hourmere-', 'proof'], ['unrelated']])
    expect(await resolveSsoDomainTxt('_hourmere-sso.example.com')).toEqual([
      ['hourmere-', 'proof'],
      ['unrelated'],
    ])
    expect(dns.resolveTxt).toHaveBeenCalledExactlyOnceWith('_hourmere-sso.example.com.')
    expect(dns.constructors).toHaveBeenCalledWith({ timeout: 5000, tries: 1 })
    expect(dns.cancel).toHaveBeenCalledOnce()
  })

  it.each([
    'example.com',
    '_hourmere-sso.Example.com',
    '_hourmere-sso.example.com.',
    '_hourmere-sso.localhost',
    '_hourmere-sso.test.local',
    '_hourmere-sso.home.arpa',
    '_hourmere-sso.127.0.0.1',
    '_hourmere-sso.999.999',
    '_hourmere-sso.*.example.com',
    '_hourmere-sso.x@example.com',
    '_hourmere-sso.-a.com',
    `_hourmere-sso.${'a'.repeat(64)}.com`,
  ])('refuses unsafe query %s before resolver construction', async (name) => {
    await expect(resolveSsoDomainTxt(name)).rejects.toMatchObject({ code: 'destination_refused' })
    expect(dns.constructors).not.toHaveBeenCalled()
  })

  it.each(['ENOTFOUND', 'ENODATA'])('treats %s as a missing TXT answer', async (code) => {
    dns.resolveTxt.mockRejectedValue({ code })
    expect(await resolveSsoDomainTxt('_hourmere-sso.example.com')).toEqual([])
  })

  it('redacts resolver errors and releases the slot', async () => {
    dns.resolveTxt.mockRejectedValue(new Error('private resolver detail'))
    const error = await resolveSsoDomainTxt('_hourmere-sso.example.com').catch(
      (error: Error) => error,
    )
    expect(error).toMatchObject({ message: 'SSO transport dns_failed', code: 'dns_failed' })
    expect((error as Error).cause).toBeUndefined()
    expect(dns.cancel).toHaveBeenCalledOnce()
    dns.resolveTxt.mockResolvedValue([])
    expect(await resolveSsoDomainTxt('_hourmere-sso.example.com')).toEqual([])
  })

  it.each([
    Array.from({ length: 33 }, () => ['x']),
    [Array.from({ length: 33 }, () => 'x')],
    [['x'.repeat(256)]],
    [Array.from({ length: 17 }, () => 'x'.repeat(255))],
    Array.from({ length: 5 }, () => Array.from({ length: 16 }, () => 'x'.repeat(255))),
  ])('bounds TXT record count, chunks and bytes (%#)', async (answers) => {
    dns.resolveTxt.mockResolvedValue(answers)
    await expect(resolveSsoDomainTxt('_hourmere-sso.example.com')).rejects.toMatchObject({
      code: 'response_too_large',
    })
    expect(dns.cancel).toHaveBeenCalledOnce()
  })

  it('cancels a stalled resolver at the absolute deadline and bounds concurrency', async () => {
    vi.useFakeTimers()
    dns.resolveTxt.mockImplementation(() => new Promise(() => {}))
    const pending = Array.from({ length: 4 }, () =>
      resolveSsoDomainTxt('_hourmere-sso.example.com').catch((error: unknown) => error),
    )
    await expect(resolveSsoDomainTxt('_hourmere-sso.example.com')).rejects.toMatchObject({
      code: 'busy',
    })
    await vi.advanceTimersByTimeAsync(SSO_TRANSPORT_LIMITS.ssoConnectTimeout)
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 4 }, () => expect.objectContaining({ code: 'timeout' })),
    )
    expect(dns.cancel).toHaveBeenCalledTimes(4)
    dns.resolveTxt.mockResolvedValue([])
    expect(await resolveSsoDomainTxt('_hourmere-sso.example.com')).toEqual([])
  })
})
