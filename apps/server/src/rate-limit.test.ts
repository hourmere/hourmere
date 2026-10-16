import { describe, expect, it } from 'vitest'
import { redactSecrets } from './app.ts'
import { createRateLimiter, PUBLIC_RATE_LIMITS } from './rate-limit.ts'

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

  it('has the documented public limits', () => {
    expect(PUBLIC_RATE_LIMITS).toEqual({
      page: { limit: 120, windowSeconds: 60 },
      slots: { limit: 120, windowSeconds: 60 },
      book: { limit: 10, windowSeconds: 60 },
      manage: { limit: 30, windowSeconds: 60 },
    })
  })
})

describe('redactSecrets', () => {
  it('removes query strings and manage tokens from logged paths', () => {
    const token = 'k3J9_aZ-x'.repeat(4).slice(0, 43)
    expect(redactSecrets(`<-- GET /api/v1/bookings/manage/${token}`)).toBe(
      '<-- GET /api/v1/bookings/manage/[redacted]',
    )
    expect(redactSecrets(`--> POST /api/v1/bookings/manage/${token}/cancel 200 5ms`)).toBe(
      '--> POST /api/v1/bookings/manage/[redacted]/cancel 200 5ms',
    )
    expect(redactSecrets('<-- GET /api/auth/magic-link/verify?token=secret')).toBe(
      '<-- GET /api/auth/magic-link/verify',
    )
    expect(redactSecrets('/api/v1/bookings/0199c3a4-0000-7000-8000-000000000000')).toBe(
      '/api/v1/bookings/0199c3a4-0000-7000-8000-000000000000',
    )
  })
})
