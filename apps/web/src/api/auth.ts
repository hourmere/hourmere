// The parts of Better Auth's own HTTP protocol (/api/auth/*) the web app uses: sign-in,
// sign-out, profile updates and API keys. It is not in our OpenAPI document (https://hourmere.com/docs/api-conventions), so
// the shapes used here are written out by hand. Errors are `{ "message", "code" }`.
import { notifyUnauthorized } from './client.ts'
import { errorFromResponse } from './errors.ts'

async function authRequest<T>(
  path: string,
  { body, signal }: { body?: object; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`/api/auth${path}`, {
    ...(body === undefined
      ? { method: 'GET' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
    ...(signal && { signal }),
  })
  if (response.status === 401) notifyUnauthorized()
  if (!response.ok) throw await errorFromResponse(response)
  return (await response.json()) as T
}

export type SocialProvider = 'google' | 'microsoft'

/** Paths in this app; Better Auth redirects there after the sign-in link or provider. */
export interface SignInRedirects {
  /** Where to land once signed in. */
  callbackURL: string
  /** Where to land when sign-in fails; Better Auth adds `?error=CODE`. */
  errorCallbackURL: string
}

/** Emails a sign-in link to `email`. */
export function sendSignInLink(email: string, redirects: SignInRedirects): Promise<unknown> {
  return authRequest('/sign-in/magic-link', { body: { email, ...redirects } })
}

/** Starts sign-in with a provider; returns the provider's page to send the browser to. */
export async function startSocialSignIn(
  provider: SocialProvider,
  redirects: SignInRedirects,
): Promise<string> {
  const { url } = await authRequest<{ url?: string }>('/sign-in/social', {
    body: { provider, ...redirects },
  })
  if (!url) throw new Error('Better Auth returned no provider URL')
  return url
}

export function signOut(): Promise<unknown> {
  return authRequest('/sign-out', { body: {} })
}

/** An API key as Better Auth lists it; the secret itself is never stored or listed. */
export interface ApiKey {
  id: string
  name: string | null
  /** The first characters of the key, e.g. `hm_AbC`, to recognize it by. */
  start: string | null
  enabled: boolean
  createdAt: string
  expiresAt: string | null
  /** When the key was last used, if ever. */
  lastRequest: string | null
  /** The organization the key acts in; the server stores it on every key it creates. */
  metadata: { organizationId?: string } | null
}

/** A key just created: the only time its secret is returned. */
export interface CreatedApiKey extends ApiKey {
  key: string
}

/** Better Auth's limits for keys created by a signed-in user. */
export const API_KEY_NAME_MAX_LENGTH = 32

export async function listApiKeys(signal?: AbortSignal): Promise<ApiKey[]> {
  const { apiKeys } = await authRequest<{ apiKeys: ApiKey[] }>(
    '/api-key/list?sortBy=createdAt&sortDirection=desc',
    signal ? { signal } : {},
  )
  return apiKeys
}

/**
 * Creates a key that acts in `organizationId` (the server refuses an organization the user
 * is not a member of). Without it the server would pick the personal organization, which
 * is not what someone working in a team expects. `expiresInSeconds` null: never expires.
 */
export function createApiKey(
  name: string,
  expiresInSeconds: number | null,
  organizationId: string,
): Promise<CreatedApiKey> {
  return authRequest('/api-key/create', {
    body: {
      name,
      ...(expiresInSeconds !== null && { expiresIn: expiresInSeconds }),
      metadata: { organizationId },
    },
  })
}

export function deleteApiKey(keyId: string): Promise<unknown> {
  return authRequest('/api-key/delete', { body: { keyId } })
}

export interface Organization {
  id: string
  name: string
}

/** The organizations the signed-in user belongs to. */
export function listOrganizations(signal?: AbortSignal): Promise<Organization[]> {
  return authRequest('/organization/list', signal ? { signal } : {})
}
