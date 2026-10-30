import { describe, expect, it, vi } from 'vitest'
import { errorFromResponse, requestError } from './errors.ts'

describe('invitation retry guidance', () => {
  it('retains a body retry interval and prefers it over the header', () => {
    expect(requestError(429, { retryAfterSeconds: 125 }, '30').retryAfterSeconds).toBe(125)
  })

  it('reads Retry-After even when an error has no JSON body', async () => {
    const error = await errorFromResponse(
      new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
    )
    expect(error.retryAfterSeconds).toBe(60)
    expect(error.status).toBe(429)
  })

  it('supports an HTTP date retry header', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-30T10:00:00Z'))
    expect(requestError(429, {}, 'Fri, 30 Oct 2026 10:02:00 GMT').retryAfterSeconds).toBe(120)
  })

  it.each([-1, '10', null, Number.NaN, Number.POSITIVE_INFINITY])(
    'ignores an invalid body retry value %s and uses the valid header',
    (retryAfterSeconds) => {
      expect(requestError(429, { retryAfterSeconds }, '45').retryAfterSeconds).toBe(45)
    },
  )

  it.each(['-1', 'nonsense', 'Infinity', ''])('ignores an invalid retry header %s', (header) => {
    expect(requestError(429, {}, header).retryAfterSeconds).toBeUndefined()
  })
})
