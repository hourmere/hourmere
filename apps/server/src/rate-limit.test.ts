import { describe, expect, it } from 'vitest'
import { createRateLimiter, PUBLIC_RATE_LIMITS, rateLimitKey } from './rate-limit.ts'

describe('createRateLimiter', () => {
  it('allows the limit per window, then says how long to wait', () => {
    let t = 0
    const limiter = createRateLimiter({ limit: 3, windowSeconds: 60 }, { now: () => t })
    expect([1, 2, 3].map(() => limiter.hit('a'))).toEqual([undefined, undefined, undefined])
    expect(limiter.hit('a')).toBe(60)
    t = 59_001
    expect(limiter.hit('a')).toBe(1)
    // Other keys have their own budget.
    expect(limiter.hit('b')).toBeUndefined()
    // A new window starts once the old one is over.
    t = 60_000
    expect(limiter.hit('a')).toBeUndefined()
  })

  it('drops the oldest keys when too many are tracked', () => {
    let t = 0
    const limiter = createRateLimiter(
      { limit: 1, windowSeconds: 60 },
      { now: () => t, maxKeys: 10 },
    )
    for (let i = 0; i < 10; i++) {
      t = i
      limiter.hit(`ip-${i}`)
    }
    expect(limiter.hit('ip-9')).toBe(60)
    // The eleventh key evicts the oldest ones, which start over; recent ones keep counting.
    limiter.hit('ip-10')
    expect(limiter.hit('ip-0')).toBeUndefined()
    expect(limiter.hit('ip-9')).toBe(60)
  })

  it('counts IPv4 clients by address and IPv6 clients by /64 network', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7')
    expect(rateLimitKey(undefined)).toBe('unknown')
    const net = '2001:db8:1:2::/64'
    for (const ip of [
      '2001:db8:1:2::1',
      '2001:0db8:0001:0002:ffff:ffff:ffff:ffff',
      '2001:DB8:1:2:a::b',
      '2001:db8:1:2::ffff:192.0.2.1',
    ]) {
      expect(rateLimitKey(ip), ip).toBe(net)
    }
    expect(rateLimitKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64')
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64')
    expect(rateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    expect(rateLimitKey('1::')).toBe('1:0:0:0::/64')
  })

  it('has the documented public limits', () => {
    expect(PUBLIC_RATE_LIMITS).toEqual({
      page: { limit: 120, windowSeconds: 60 },
      slots: { limit: 120, windowSeconds: 60 },
      book: { limit: 10, windowSeconds: 60 },
      manage: { limit: 30, windowSeconds: 60 },
    })
  })
})
