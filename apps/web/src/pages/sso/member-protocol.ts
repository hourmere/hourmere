import { api } from '../../api/client.ts'
import { requestError } from '../../api/errors.ts'
import { safeNextPath } from '../../next-path.ts'
import { PATHS } from '../../paths.ts'

const signInReturnKey = 'hourmere.sso-sign-in-return'
const signInLifetimeMs = 10 * 60 * 1000

/** Fetch strips the fragment from Response.url. Keep it in the sign-in tab across the IdP visit. */
export function rememberOidcReturnFragment(path: string) {
  try {
    if (path.includes('#')) {
      sessionStorage.setItem(signInReturnKey, JSON.stringify([Date.now() + signInLifetimeMs, path]))
    } else {
      sessionStorage.removeItem(signInReturnKey)
    }
  } catch {
    // Sign-in can still complete if the browser does not allow session storage.
  }
}

/** Restore only the fragment of the destination the server accepted for this sign-in. */
export function takeOidcReturnFragment(path: string | null): string | null {
  try {
    const saved = sessionStorage.getItem(signInReturnKey)
    sessionStorage.removeItem(signInReturnKey)
    if (!path || !saved) return path
    const entry: unknown = JSON.parse(saved)
    if (!Array.isArray(entry)) return path
    const [expiresAt, destination] = entry
    if (
      typeof expiresAt === 'number' &&
      expiresAt > Date.now() &&
      typeof destination === 'string' &&
      destination.startsWith(`${path}#`) &&
      destination === safeNextPath(destination)
    )
      return destination
  } catch {
    // Storage may be disabled or its contents may have changed in another version.
  }
  return path
}

export function oidcAttemptId(value: string | null | undefined): string | null {
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null
}

export function mailboxToken(link: string, attemptId: string): string | null {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    return null
  }
  if (
    url.origin !== window.location.origin ||
    url.pathname !== PATHS.mailboxProof ||
    url.search ||
    url.username ||
    url.password
  )
    return null
  const params = new URLSearchParams(url.hash.slice(1))
  const attempts = params.getAll('attempt')
  const tokens = params.getAll('token')
  const token = tokens[0]
  return attempts.length === 1 &&
    attempts[0] === attemptId &&
    tokens.length === 1 &&
    token &&
    token.length <= 256
    ? token
    : null
}

export function openMailboxProofChannel(attemptId: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    return new BroadcastChannel(`hourmere.sso-mailbox-proof.${attemptId}`)
  } catch {
    return null
  }
}

function completionRedirect(response: Response) {
  if (!response.redirected) return null
  void response.body?.cancel().catch(() => {})
  const url = new URL(response.url)
  const path = url.pathname + url.search + url.hash
  return url.origin === window.location.origin && path === safeNextPath(path)
    ? { kind: 'redirect' as const, path }
    : null
}

export async function completeOidcAttempt(
  attemptId: string,
  signal: AbortSignal,
): Promise<{ kind: 'redirect'; path: string } | { kind: 'link_required' }> {
  // The completion response can set a session cookie and redirect to SPA HTML.
  // Keep the response unparsed and let the browser follow its same-origin redirect.
  const { response, error } = await api.POST('/api/auth/sso/oidc/complete', {
    body: { attemptId },
    parseAs: 'stream',
    mode: 'same-origin',
    signal,
  })
  if (!response.ok) throw requestError(response.status, error, response.headers.get('Retry-After'))
  if (response.redirected) {
    const result = completionRedirect(response)
    if (result) return result
  } else if ((await response.json())?.status === 'link_required') {
    return { kind: 'link_required' }
  }
  throw new Error('Invalid SSO completion response')
}

export async function completeSamlMailboxAttempt(attemptId: string, signal: AbortSignal) {
  const response = await fetch('/api/auth/sso/saml2/complete', {
    method: 'POST',
    body: new URLSearchParams({ attemptId }),
    mode: 'same-origin',
    signal,
  })
  if (!response.ok)
    throw requestError(response.status, undefined, response.headers.get('Retry-After'))
  return completionRedirect(response)
}
