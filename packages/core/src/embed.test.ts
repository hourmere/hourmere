import { describe, expect, it } from 'vitest'
import { embedOrigin, embedParent, publicBookingPath } from './embed.ts'

const id = 'abcdefghijklmnop1234'
describe('embed origin and route boundaries', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['https://EXAMPLE.com:443/', 'https://example.com'],
    ['http://localhost:5000', 'http://localhost:5000'],
    ['http://127.0.0.1:5000', 'http://127.0.0.1:5000'],
    ['http://[::1]:5000', 'http://[::1]:5000'],
  ])('canonicalizes %s', (value, expected) => expect(embedOrigin(value)).toBe(expected))
  it.each([
    '*',
    'null',
    'https://*.example.com',
    'http://example.com',
    'http://localhost.evil.com',
    'https://u:p@example.com',
    'https://example.com/path',
    'https://example.com/?q=1',
    'https://example.com/#fragment',
    ' https://example.com',
    'https://example.com\\@evil.com',
    'javascript:alert(1)',
    `https://${'a'.repeat(2050)}`,
  ])('rejects unsafe origin %s', (value) => expect(embedOrigin(value)).toBeUndefined())
  it.each([
    ['/ada/intro', '/ada/intro'],
    ['/Ada/Intro/', '/ada/intro'],
    ['/team/Alpha/Intro', '/team/Alpha/intro'],
  ])('accepts only a public booking path %s', (path, result) =>
    expect(publicBookingPath(path)).toBe(result),
  )
  it.each([
    '/api/auth',
    '/app/settings',
    '/oauth/consent',
    '/booking/secret',
    '/embed/a',
    '/team/settings',
    '/team/admin/call',
    '/ada',
    '/ada/call/extra',
    '/a%2fb/call',
    '/ada//call',
  ])('rejects account/invalid path %s', (path) => expect(publicBookingPath(path)).toBeUndefined())
  it('requires an approved exact parent, a dedicated route, and one valid instance id', () => {
    const url = new URL(
      `https://hourmere.test/embed/ada/intro?parentOrigin=https%3A%2F%2Fexample.com&embedId=${id}`,
    )
    expect(embedParent(url, ['https://example.com'])).toBe('https://example.com')
    expect(embedParent(url, [])).toBeUndefined()
    expect(embedParent(url, ['https://sub.example.com'])).toBeUndefined()
    for (const change of [
      (u: URL) => (u.pathname = '/app/settings'),
      (u: URL) => (u.pathname = '/embed/app/settings'),
      (u: URL) => u.searchParams.append('parentOrigin', 'https://example.com'),
      (u: URL) => u.searchParams.append('embedId', id),
      (u: URL) => u.searchParams.set('embedId', 'short'),
      (u: URL) => u.searchParams.delete('parentOrigin'),
    ]) {
      const modified = new URL(url)
      change(modified)
      expect(embedParent(modified, ['https://example.com'])).toBeUndefined()
    }
  })
})
