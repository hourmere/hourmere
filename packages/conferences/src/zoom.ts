import { createHash } from 'node:crypto'
import { isSingleLineText } from '@hourmere/scheduling/text'
import { z } from 'zod'

export const ZOOM_CALLBACK = '/api/conference/zoom/callback'
export const ZOOM_SCOPE = 'user:read:user'
export type ZoomFailure = 'provider_unavailable' | 'needs_reauth' | 'permissions_missing'
/** Upstream bodies, request URLs and credentials never become messages/causes. */
export class ZoomError extends Error {
  readonly code: ZoomFailure
  constructor(code: ZoomFailure) {
    super(code)
    this.name = 'ZoomError'
    this.code = code
  }
}
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
  return scopes.length === 1 && scopes[0] === ZOOM_SCOPE
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let rejectAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new ZoomError('provider_unavailable'))
    signal.addEventListener('abort', rejectAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (rejectAbort) signal.removeEventListener('abort', rejectAbort)
  }
}
/** Fixed official hosts and fixed callback; provider api_url fields are intentionally ignored. */
export function createZoomClient(
  config: ZoomConfig,
  request: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const callback = new URL(ZOOM_CALLBACK, config.publicUrl).href
  async function json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    maximum = 131072,
  ): Promise<unknown> {
    let response: Response | undefined
    try {
      signal.throwIfAborted()
      response = await abortable(request(url, { ...init, redirect: 'error', signal }), signal)
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new ZoomError(
          response.status === 400 || response.status === 401
            ? 'needs_reauth'
            : response.status === 403
              ? 'permissions_missing'
              : 'provider_unavailable',
        )
      }
      if (!response.body) throw new ZoomError('provider_unavailable')
      const reader = response.body.getReader(),
        parts: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const { done, value } = await abortable(reader.read(), signal)
          if (done) break
          length += value.byteLength
          if (length > maximum) throw new ZoomError('provider_unavailable')
          parts.push(value)
        }
      } finally {
        void reader.cancel().catch(() => {})
      }
      return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
    } catch (error) {
      if (error instanceof ZoomError) throw error
      throw new ZoomError('provider_unavailable')
    }
  }
  async function tokens(body: Record<string, string>, signal: AbortSignal): Promise<ZoomTokens> {
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
    if (!minimalZoomScopes(scopes)) throw new ZoomError('permissions_missing')
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt: now() + value.expires_in * 1000,
      scopes,
    }
  }
  return {
    authorizationUrl(state: string, verifier: string) {
      const url = new URL('https://zoom.us/oauth/authorize')
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: callback,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        scope: ZOOM_SCOPE,
        optional_scope: '',
      }).toString()
      return url.href
    },
    exchange(code: string, verifier: string, signal: AbortSignal) {
      return tokens(
        { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: callback },
        signal,
      )
    },
    refresh(refreshToken: string, signal: AbortSignal) {
      return tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal)
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
