// The parts of Better Auth's own HTTP protocol (/api/auth/*) the web app uses: sign-in,
// sign-out, organizations and API keys. It is not in our OpenAPI document (https://hourmere.com/docs/api-conventions), so
// the shapes used here are written out by hand. Errors are `{ "message", "code" }`.
import { safeNextPath, signInPath } from '../next-path.ts'
import { api, notifyUnauthorized, type Schemas, unwrap } from './client.ts'
import { errorFromResponse } from './errors.ts'

async function authRequest<T>(
  path: string,
  {
    body,
    signal,
    headers,
  }: { body?: object; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<T> {
  const response = await fetch(`/api/auth${path}`, {
    ...(body === undefined
      ? { method: 'GET' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
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

/** Keep both callbacks in the same safe return flow, even for a future adapter caller. */
function checkedSignInRedirects(redirects: SignInRedirects): SignInRedirects {
  if (
    safeNextPath(redirects.callbackURL) !== redirects.callbackURL ||
    redirects.errorCallbackURL !== signInPath(redirects.callbackURL)
  )
    throw new Error('Invalid sign-in callback path')
  return redirects
}

/** Emails a sign-in link to `email`. */
export async function sendSignInLink(email: string, redirects: SignInRedirects): Promise<unknown> {
  return authRequest('/sign-in/magic-link', {
    body: { email, ...checkedSignInRedirects(redirects) },
  })
}

/** Starts sign-in with a provider; returns the provider's page to send the browser to. */
export async function startSocialSignIn(
  provider: SocialProvider,
  redirects: SignInRedirects,
): Promise<string> {
  const { url } = await authRequest<{ url?: string }>('/sign-in/social', {
    body: { provider, ...checkedSignInRedirects(redirects) },
  })
  if (!url) throw new Error('Better Auth returned no provider URL')
  return url
}

export function signOut(): Promise<unknown> {
  return authRequest('/sign-out', { body: {} })
}

/** Current Better Auth identity; /me intentionally omits email verification state. */
export function getInvitationSession(signal?: AbortSignal): Promise<{
  user: { id: string; email: string; emailVerified: boolean }
} | null> {
  return authRequest('/get-session', signal ? { signal } : {})
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
  slug: string
  logo: string | null
  createdAt: string
  /** Better Auth may return stored JSON text on list/switch, parsed metadata on create. */
  metadata?: Record<string, unknown> | string | null
}

export interface OrganizationMember {
  id: string
  organizationId: string
  userId: string
  role: string
  createdAt: string
}

/** Better Auth invitation dates are JSON strings; expiry is separate from stored status. */
export interface Invitation {
  id: string
  email: string
  role: string
  organizationId: string
  inviterId: string
  status: 'pending' | 'accepted' | 'rejected' | 'canceled'
  expiresAt: string
  createdAt: string
}

export interface QueuedInvitation extends Invitation {
  existing: boolean
  delivery: {
    generation: number
    state: Schemas['TeamInvitationSummary']['delivery']['state']
    attempts: number
  }
}

/** Admission confirms durable queueing, while retaining an existing invitation on retry. */
export function inviteMember(
  email: string,
  organizationId: string,
  signal?: AbortSignal,
): Promise<QueuedInvitation> {
  return authRequest('/organization/invite-member', {
    body: { email, organizationId, role: 'member' },
    headers: { 'X-Expected-Organization-Id': organizationId },
    ...(signal && { signal }),
  })
}

/** Resending retains one request ID across uncertain delivery retries. */
export function resendInvitation(
  invitation: QueuedInvitation,
  organizationId: string,
  requestId: string,
  signal?: AbortSignal,
): Promise<QueuedInvitation> {
  return authRequest('/organization/invite-member', {
    body: {
      email: invitation.email,
      organizationId,
      role: 'member',
      resend: true,
      invitationId: invitation.id,
      expectedGeneration: invitation.delivery.generation,
      requestId,
    },
    headers: { 'X-Expected-Organization-Id': organizationId },
    ...(signal && { signal }),
  })
}

/** Only the signed-in, verified recipient can read these invitation details. */
export interface InvitationDetails extends Invitation {
  organizationName: string
  organizationSlug: string
  inviterEmail: string
}

export interface AcceptedInvitation {
  invitation: Invitation & { status: 'accepted' }
  member: OrganizationMember
}

/** Lookup uses `id`, unlike the accept endpoint's `invitationId` body field. */
export function getInvitation(id: string, signal?: AbortSignal): Promise<InvitationDetails> {
  return authRequest(
    `/organization/get-invitation?${new URLSearchParams({ id })}`,
    signal ? { signal } : {},
  )
}

/** Explicit acceptance only; signing in or looking up an invitation never calls this. */
export function acceptInvitation(
  invitationId: string,
  signal?: AbortSignal,
): Promise<AcceptedInvitation> {
  return authRequest('/organization/accept-invitation', {
    body: { invitationId },
    ...(signal && { signal }),
  })
}

/** Better Auth 1.7.10 returns the organization plus its creator's membership. */
export interface CreatedOrganization extends Organization {
  metadata?: Record<string, unknown> | null
  members: OrganizationMember[]
}

/** Browser creation always uses the signed-in user; no server-only userId override. */
export interface CreateOrganizationInput {
  name: string
  slug: string
  logo?: string | null
  metadata?: Record<string, unknown>
  keepCurrentActiveOrganization?: boolean
}

export interface CreateOrganizationResult {
  organization: CreatedOrganization
  /**
   * The caller and active organization confirmed after creation. Use me.organization for
   * active context: it may differ from the created organization when keeping the current
   * one or when another tab switches. This does not update the SessionProvider by itself.
   */
  me: Schemas['Me']
}

/**
 * Creates once, then confirms active context through /me instead of assuming activation.
 * If confirmation fails or is cancelled, creation may already have committed: refresh
 * the session/list before offering a retry; never automatically repeat the POST.
 */
export async function createOrganization(
  input: CreateOrganizationInput,
  signal?: AbortSignal,
): Promise<CreateOrganizationResult> {
  const organization = await authRequest<CreatedOrganization>('/organization/create', {
    body: input,
    ...(signal && { signal }),
  })
  const me = await unwrap(api.GET('/api/v1/me', { signal }))
  return { organization, me }
}

export interface SetActiveOrganizationInput {
  /** Takes precedence over the slug; null clears the session's active organization. */
  organizationId?: string | null
  organizationSlug?: string
}

/** Optional source context protects automatic follow-ups; the body still selects the target. */
export function setActiveOrganization(
  input: SetActiveOrganizationInput,
  signal?: AbortSignal,
  expectedOrganizationId?: string,
): Promise<Organization | null> {
  return authRequest('/organization/set-active', {
    body: input,
    ...(expectedOrganizationId && {
      headers: { 'X-Expected-Organization-Id': expectedOrganizationId },
    }),
    ...(signal && { signal }),
  })
}

/** Memberships only; this response has no personal marker or caller role. */
export function listOrganizations(signal?: AbortSignal): Promise<Organization[]> {
  return authRequest('/organization/list', signal ? { signal } : {})
}

/**
 * The caller's membership in the session's active organization. Better Auth ignores
 * organization selectors here: check organizationId and userId before using the result
 * with a previously loaded /me context, since another tab can switch organizations.
 */
export function getActiveOrganizationMember(signal?: AbortSignal): Promise<OrganizationMember> {
  return authRequest('/organization/get-active-member', signal ? { signal } : {})
}

/** A joined member; ordinary members receive only the public user summary. */
export interface ListedOrganizationMember extends OrganizationMember {
  user: { id: string; name: string; email?: string; image?: string | null }
}

export interface OrganizationMemberPage {
  members: ListedOrganizationMember[]
  total: number
}

/** Explicit organization and stable ordering keep paging bound to this settings view. */
export function listOrganizationMembers(
  organizationId: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<OrganizationMemberPage> {
  const query = new URLSearchParams({
    organizationId,
    offset: String(offset),
    limit: String(limit),
    sortBy: 'id',
    sortDirection: 'asc',
  })
  return authRequest(`/organization/list-members?${query}`, signal ? { signal } : {})
}
