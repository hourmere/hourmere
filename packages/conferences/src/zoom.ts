import { createHash } from 'node:crypto'
import { isSingleLineText } from '@hourmere/scheduling/text'
import { z } from 'zod'
import { boundedZoomJson, ZoomError } from './transport.ts'

export const ZOOM_CALLBACK = '/api/conference/zoom/callback'
export const ZOOM_SCOPE = 'user:read:user'
export const ZOOM_MEETING_SCOPES = [
  ZOOM_SCOPE,
  'meeting:write:meeting',
  'meeting:read:meeting',
  'meeting:update:meeting',
  'meeting:delete:meeting',
] as const
export type ZoomMode = 'identity' | 'meetings'
export function zoomScopes(mode: ZoomMode): string[] {
  return mode === 'meetings' ? [...ZOOM_MEETING_SCOPES] : [ZOOM_SCOPE]
}
/** Conservative exact-set policy; order is canonicalized before persistence. */
export function matchingZoomScopes(scopes: readonly string[], mode: string): boolean {
  if (mode !== 'identity' && mode !== 'meetings') return false
  const expected = zoomScopes(mode)
  return (
    scopes.length === expected.length &&
    new Set(scopes).size === scopes.length &&
    expected.every((scope) => scopes.includes(scope))
  )
}

export { ZoomError, type ZoomFailure } from './transport.ts'
export interface ZoomTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
}
export interface ZoomIdentity {
  id: string
  email: string | null
  name: string | null
}
export interface ZoomConfig {
  clientId: string
  clientSecret: string
  publicUrl: string
}
const opaque = z
  .string()
  .min(1)
  .max(8192)
  .refine(isSingleLineText)
  .refine((value) => !/\s/u.test(value))
const tokenSchema = z.object({
  access_token: opaque,
  refresh_token: opaque,
  expires_in: z.number().int().min(1).max(86400),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  scope: z.string().min(1).max(2048),
})
const name = z.string().max(200).refine(isSingleLineText)
const identitySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  email: z.email().max(320).optional(),
  display_name: name.optional(),
  first_name: name.optional(),
  last_name: name.optional(),
})
export function minimalZoomScopes(scopes: readonly string[]): boolean {
  return matchingZoomScopes(scopes, 'identity')
}

/** Fixed official hosts and fixed callback; provider api_url fields are intentionally ignored. */
export function createZoomClient(
  config: ZoomConfig,
  request: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const callback = new URL(ZOOM_CALLBACK, config.publicUrl).href
  const json = (url: string, init: RequestInit, signal: AbortSignal, maximum?: number) =>
    boundedZoomJson(request, url, init, signal, { maximum, badRequestReauth: true })
  async function tokens(
    body: Record<string, string>,
    signal: AbortSignal,
    mode: ZoomMode,
  ): Promise<ZoomTokens> {
    const parsed = tokenSchema.safeParse(
      await json(
        'https://zoom.us/oauth/token',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
          },
          body: new URLSearchParams({
            ...body,
            client_id: config.clientId,
            client_secret: config.clientSecret,
          }),
        },
        signal,
        32768,
      ),
    )
    if (!parsed.success) throw new ZoomError('provider_unavailable')
    const value = parsed.data,
      scopes = value.scope.trim().split(/\s+/)
    // Never infer omitted scope or inherit an older, broader grant.
    if (!matchingZoomScopes(scopes, mode)) throw new ZoomError('permissions_missing')
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt: now() + value.expires_in * 1000,
      scopes: zoomScopes(mode),
    }
  }
  return {
    authorizationUrl(state: string, verifier: string, mode: ZoomMode = 'identity') {
      const url = new URL('https://zoom.us/oauth/authorize')
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: callback,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        scope: zoomScopes(mode).join(' '),
        optional_scope: '',
      }).toString()
      return url.href
    },
    exchange(code: string, verifier: string, signal: AbortSignal, mode: ZoomMode = 'identity') {
      return tokens(
        { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: callback },
        signal,
        mode,
      )
    },
    refresh(refreshToken: string, signal: AbortSignal, mode: ZoomMode = 'identity') {
      return tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal, mode)
    },
    async identity(accessToken: string, signal: AbortSignal): Promise<ZoomIdentity> {
      const parsed = identitySchema.safeParse(
        await json(
          'https://api.zoom.us/v2/users/me',
          { headers: { authorization: `Bearer ${accessToken}` } },
          signal,
        ),
      )
      if (!parsed.success) throw new ZoomError('provider_unavailable')
      const value = parsed.data,
        full = Array.from(
          value.display_name?.trim() ||
            [value.first_name, value.last_name].filter(Boolean).join(' ').trim(),
        )
          .slice(0, 200)
          .join('')
      return { id: value.id, email: value.email ?? null, name: full || null }
    },
  }
}
export type ZoomClient = ReturnType<typeof createZoomClient>
