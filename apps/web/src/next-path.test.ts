import { describe, expect, it } from 'vitest'
import { safeNextPath, signInPath } from './next-path.ts'

describe('safeNextPath', () => {
  it.each([
    ['/app', '/app'],
    ['/oauth/authorize?client_id=test&sig=abc', '/oauth/authorize?client_id=test&sig=abc'],
    ['/app/', '/app/'],
    ['/app/api-keys', '/app/api-keys'],
    ['/app/bookings?tab=past', '/app/bookings?tab=past'],
    [
      '/app/join?invitationId=00000000-0000-7000-8000-000000000001',
      '/app/join?invitationId=00000000-0000-7000-8000-000000000001',
    ],
    ['/app/settings#profile', '/app/settings#profile'],
    [
      '/app/event-types/00000000-0000-7000-8000-000000000001',
      '/app/event-types/00000000-0000-7000-8000-000000000001',
    ],
    ['/app/a/../api-keys', '/app/api-keys'],
    ['/app/bookings?next=%2F%2Fexample.com', '/app/bookings?next=%2F%2Fexample.com'],
    [`/app/${'a'.repeat(2043)}`, `/app/${'a'.repeat(2043)}`],
  ])('keeps the signed-in page %s', (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected)
  })

  it.each([
    [null],
    [''],
    ['app/api-keys'],
    ['https://evil.example/'],
    ['https://evil.example/app'],
    ['https://evil.example/app/join?invitationId=00000000-0000-7000-8000-000000000001'],
    ['javascript:alert(1)'],
    ['//evil.example'],
    ['//evil.example/app'],
    ['///evil.example'],
    ['/\\evil.example'],
    ['/\\/evil.example'],
    ['/.//evil.example'],
    ['/a/..//evil.example'],
    ['/app/..//evil.example'],
    ['/\t/evil.example'],
    ['/\n/evil.example'],
    ['/ /evil.example'],
    ['/app\t/x'],
    ['/\u0000x'],
    // The start page and pages outside /app: public booking pages, old app addresses.
    ['/'],
    ['/ada/intro-call'],
    ['/api-keys'],
    ['/event-types'],
    ['/settings?tab=profile'],
    ['/apple'],
    ['/app-keys'],
    ['/application/x'],
    ['/APP/settings'],
    ['/app/../api-keys'],
    ['/app/%2e%2e/api-keys'],
    // Sign-in itself and the server's page for emailed links.
    ['/sign-in'],
    ['/oauth/consent?sig=abc'],
    ['/oauth/authorize/../consent'],
    ['/oauth/authorize-more'],
    ['/oauth/authorize?' + 'x'.repeat(20000)],
    ['/sign-in?next=/app/api-keys'],
    ['/sign-in/confirm'],
    ['/sign-in/confirm#token=x'],
    // Better Auth refuses encoded separators in a callbackURL; sign-in would fail.
    ['/app/%2F%2Fexample.com'],
    ['/app/a%2fb'],
    ['/app/%5Cexample.com'],
    ['/app/a%5cb'],
    ['/app%2fjoin?invitationId=00000000-0000-7000-8000-000000000001'],
    ['/app/%5c%5cevil.example/join'],
    // The API, not pages.
    ['/api'],
    ['/api/v1/me'],
    ['/app/../api/auth/sign-out'],
    // Too long, before or after normalizing.
    [`/app/${'a'.repeat(2044)}`],
    [`/app/${'a/../'.repeat(500)}x`],
    [`/app/${'é'.repeat(400)}`],
  ])('falls back to the default page for %j', (raw) => {
    expect(safeNextPath(raw)).toBe('/app')
  })
})

describe('signInPath', () => {
  it('remembers the page to come back to', () => {
    expect(signInPath('/app/api-keys?x=1')).toBe('/sign-in?next=%2Fapp%2Fapi-keys%3Fx%3D1')
  })

  it('remembers the invitation identifier without moving it to a public page', () => {
    expect(signInPath('/app/join?invitationId=00000000-0000-7000-8000-000000000001')).toBe(
      '/sign-in?next=%2Fapp%2Fjoin%3FinvitationId%3D00000000-0000-7000-8000-000000000001',
    )
  })

  it('leaves out the default page and anything outside the app', () => {
    expect(signInPath('/app')).toBe('/sign-in')
    expect(signInPath('/')).toBe('/sign-in')
    expect(signInPath('/api-keys')).toBe('/sign-in')
    expect(signInPath('//evil.example')).toBe('/sign-in')
  })
})
