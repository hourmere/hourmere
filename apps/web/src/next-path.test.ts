import { describe, expect, it } from 'vitest'
import { safeNextPath, signInPath } from './next-path.ts'

describe('safeNextPath', () => {
  it.each([
    ['/api-keys', '/api-keys'],
    ['/bookings?status=upcoming', '/bookings?status=upcoming'],
    ['/settings#profile', '/settings#profile'],
    ['/a/../api-keys', '/api-keys'],
    ['/%2F%2Fexample.com', '/%2F%2Fexample.com'],
  ])('keeps the path on this site %s', (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected)
  })

  it.each([
    [null],
    [''],
    ['api-keys'],
    ['https://evil.example/'],
    ['javascript:alert(1)'],
    ['//evil.example'],
    ['///evil.example'],
    ['/\\evil.example'],
    ['/\\/evil.example'],
    ['/.//evil.example'],
    ['/a/..//evil.example'],
    ['/\t/evil.example'],
    ['/\n/evil.example'],
    ['/ /evil.example'],
    ['/\u0000x'],
    ['/sign-in'],
    ['/sign-in?next=/api-keys'],
  ])('falls back to the start page for %j', (raw) => {
    expect(safeNextPath(raw)).toBe('/')
  })
})

describe('signInPath', () => {
  it('remembers the page to come back to', () => {
    expect(signInPath('/api-keys?x=1')).toBe('/sign-in?next=%2Fapi-keys%3Fx%3D1')
  })

  it('leaves out the start page and anything unsafe', () => {
    expect(signInPath('/')).toBe('/sign-in')
    expect(signInPath('//evil.example')).toBe('/sign-in')
  })
})
