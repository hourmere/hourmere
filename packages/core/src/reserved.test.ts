import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  CLAIM_RESERVED_HANDLES,
  isClaimReservedHandle,
  isPublicTeamSlug,
  isReservedName,
  RESERVED_NAMES,
} from './reserved.ts'

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

  it('keeps waitlist available to existing personal and team accounts, including in a source copy', () => {
    const assertCompatible = (reserved = isReservedName, team = isPublicTeamSlug) => {
      for (const name of ['waitlist', 'Waitlist']) {
        expect(reserved(name)).toBe(false)
        expect(team(name)).toBe(true)
      }
    }
    assertCompatible()
    const source = readFileSync(new URL('./reserved.ts', import.meta.url), 'utf8')
    const marker = "  'booking',"
    expect(source.includes(marker)).toBe(true)
    const copied = new Function(
      `${stripTypeScriptTypes(source.replace(marker, `${marker}\n  'waitlist',`)).replace(/\bexport /g, '')}; return { isReservedName, isPublicTeamSlug }`,
    )() as { isReservedName: typeof isReservedName; isPublicTeamSlug: typeof isPublicTeamSlug }
    expect(() => assertCompatible(copied.isReservedName, copied.isPublicTeamSlug)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})

describe('claim-reserved handles', () => {
  type Names = {
    isReservedName: typeof isReservedName
    isPublicTeamSlug: typeof isPublicTeamSlug
    isClaimReservedHandle: typeof isClaimReservedHandle
  }
  // `route` is refused only as a newly claimed personal handle: never a reserved name (that
  // would stop serving a legacy `route` owner's pages) and still a valid team slug.
  const assertRoute = ({ isReservedName, isPublicTeamSlug, isClaimReservedHandle }: Names) => {
    for (const name of ['route', 'Route', 'ROUTE']) {
      expect(isClaimReservedHandle(name), name).toBe(true)
      expect(isReservedName(name), name).toBe(false)
      expect(isPublicTeamSlug(name), name).toBe(true)
    }
    for (const name of ['router', 'routes', 'my-route', 'routing', 'admin', ''])
      expect(isClaimReservedHandle(name), name).toBe(false)
  }
  const copy = (change?: readonly [string, string]): Names => {
    let source = readFileSync(new URL('./reserved.ts', import.meta.url), 'utf8')
    if (change) {
      expect(source.includes(change[0]), change[0]).toBe(true)
      source = source.replace(...change)
    }
    return new Function(
      `${stripTypeScriptTypes(source).replace(/\bexport /g, '')}; return { isReservedName, isPublicTeamSlug, isClaimReservedHandle }`,
    )() as Names
  }

  it('reserve route for claims only, in any case, and are listed in lowercase', () => {
    assertRoute({ isReservedName, isPublicTeamSlug, isClaimReservedHandle })
    assertRoute(copy())
    expect([...CLAIM_RESERVED_HANDLES]).toEqual(['route'])
    expect(RESERVED_NAMES.has('route')).toBe(false)
  })

  it.each([
    ['the route entry', "new Set(['route'])", 'new Set([])'],
    [
      'case folding',
      'CLAIM_RESERVED_HANDLES.has(name.toLowerCase())',
      'CLAIM_RESERVED_HANDLES.has(name)',
    ],
    ['the separate list (route made a reserved name)', "  'booking',", "  'booking',\n  'route',"],
  ])('fail in a source copy without %s', (_, before, after) => {
    expect(() => assertRoute(copy([before, after]))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
