import { describe, expect, it } from 'vitest'
import { isReservedName, RESERVED_NAMES } from './reserved.ts'

describe('reserved names', () => {
  it('cover the top-level paths of the app, the server and the product', () => {
    for (const name of [
      // Agreed with the project lead as the minimum.
      'app',
      'api',
      'assets',
      'booking',
      'book',
      'manage',
      'me',
      'health',
      'webhooks',
      'sign-in',
      'sign-up',
      'sign-out',
      'login',
      'logout',
      'mcp',
      'docs',
      'help',
      'support',
      'admin',
      'settings',
      'account',
      'billing',
      'pricing',
      'about',
      'terms',
      'privacy',
      'security',
      'status',
      'blog',
      'static',
      'public',
      'well-known',
      '.well-known',
      'favicon.ico',
      'hourmere-embed.js',
      'robots.txt',
      'sitemap.xml',
      // The web app's top-level routes today (before the signed-in app moves under /app).
      'event-types',
      'availability',
      'bookings',
      'api-keys',
      // Team pages live under /t/{org-slug}.
      't',
    ]) {
      expect(RESERVED_NAMES, name).toContain(name)
    }
  })

  it('are listed in lowercase', () => {
    for (const name of RESERVED_NAMES) expect(name).toBe(name.toLowerCase())
  })

  it('match regardless of case', () => {
    expect(isReservedName('admin')).toBe(true)
    expect(isReservedName('Admin')).toBe(true)
    expect(isReservedName('SIGN-IN')).toBe(true)
    expect(isReservedName('Robots.TXT')).toBe(true)
    expect(isReservedName('ada')).toBe(false)
    expect(isReservedName('admins')).toBe(false)
    expect(isReservedName('')).toBe(false)
  })
})
