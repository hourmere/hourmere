import { describe, expect, it, vi } from 'vitest'
import { rememberVisitorTimeZone, visitorTimeZone } from './visitor-time-zone.ts'

const STORAGE_KEY = 'hourmere-visitor-time-zone'

describe('the visitor time zone preference', () => {
  it('uses a valid explicit choice, including an IANA alias, ahead of the fallback', () => {
    rememberVisitorTimeZone('US/Eastern')
    expect(visitorTimeZone('Asia/Shanghai')).toBe('US/Eastern')
  })

  it.each(['', 'Atlantis/Nowhere', '+08:00', '-05:00'])(
    'ignores an invalid saved zone %j',
    (zone) => {
      localStorage.setItem(STORAGE_KEY, zone)
      expect(visitorTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
      rememberVisitorTimeZone(zone)
      expect(localStorage.getItem(STORAGE_KEY)).toBe(zone)
    },
  )

  it('does not persist a fallback or overwrite a prior explicit choice with an invalid zone', () => {
    expect(visitorTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    rememberVisitorTimeZone('America/Los_Angeles')
    rememberVisitorTimeZone('+08:00')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('America/Los_Angeles')
  })

  it('tolerates blocked storage reads, writes and access to localStorage itself', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Unavailable', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    expect(() => visitorTimeZone('Asia/Shanghai')).not.toThrow()
    expect(visitorTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(() => rememberVisitorTimeZone('America/Los_Angeles')).not.toThrow()
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Unavailable', 'SecurityError')
    })
    expect(() => visitorTimeZone('Asia/Shanghai')).not.toThrow()
    expect(visitorTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(() => rememberVisitorTimeZone('America/Los_Angeles')).not.toThrow()
  })
})
