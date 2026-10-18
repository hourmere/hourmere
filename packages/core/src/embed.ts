import { explicitLanguage } from './language.ts'
import { isPublicTeamSlug, isReservedName } from './reserved.ts'

/** A canonical exact HTTPS origin; loopback HTTP is allowed only for local development. */
export function embedOrigin(value: string): string | undefined {
  if (value.length > 2048 || /[\s\\*]/.test(value)) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin === 'null' ||
    url.hostname.includes('*') ||
    url.hostname.includes('%')
  )
    return undefined
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    return undefined
  return url.origin
}
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/i
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i
/** Only public booking paths, never account, OAuth, API or invitee management pages. */
export function publicBookingPath(pathname: string): string | undefined {
  const parts = pathname.replace(/\/$/, '').split('/').slice(1)
  if (
    parts.length === 3 &&
    parts[0] === 'team' &&
    isPublicTeamSlug(parts[1] ?? '') &&
    SLUG.test(parts[2] ?? '')
  )
    return `/team/${parts[1]}/${parts[2]?.toLowerCase()}`
  if (
    parts.length === 2 &&
    HANDLE.test(parts[0] ?? '') &&
    !isReservedName(parts[0] ?? '') &&
    SLUG.test(parts[1] ?? '')
  )
    return `/${parts[0]?.toLowerCase()}/${parts[1]?.toLowerCase()}`
  return undefined
}
export const EMBED_ID = /^[a-zA-Z0-9_-]{16,64}$/
/** Checks both the dedicated route and the explicitly configured parent allow list. */
export function embedParent(url: URL, allowedOrigins: readonly string[]): string | undefined {
  if (
    !url.pathname.startsWith('/embed/') ||
    !publicBookingPath(url.pathname.slice('/embed'.length))
  )
    return undefined
  if (
    url.searchParams.getAll('parentOrigin').length !== 1 ||
    url.searchParams.getAll('embedId').length !== 1 ||
    !EMBED_ID.test(url.searchParams.get('embedId') ?? '') ||
    url.searchParams.getAll('language').length > 1 ||
    (url.searchParams.has('language') && !explicitLanguage(url.searchParams.get('language')))
  )
    return undefined
  const origin = embedOrigin(url.searchParams.get('parentOrigin') ?? '')
  return origin && allowedOrigins.includes(origin) ? origin : undefined
}
