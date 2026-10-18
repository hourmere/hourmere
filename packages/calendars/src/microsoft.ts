import { createHash } from 'node:crypto'
import { isSingleLineText } from '@hourmere/scheduling/text'
import { z } from 'zod'
import {
  CalendarProviderError,
  type CalendarTokens,
  type OAuthTokenError,
  type ProviderCalendar,
  readOAuthTokenError,
} from './provider.ts'

export const MICROSOFT_CALENDAR_CALLBACK = '/api/calendar/microsoft/callback'
export const MICROSOFT_CALENDAR_SCOPES = [
  'openid',
  'email',
  'offline_access',
  'https://graph.microsoft.com/Calendars.ReadBasic',
] as const

export class MicrosoftCalendarError extends CalendarProviderError {
  constructor(code: CalendarProviderError['code'], status?: number, oauthError?: OAuthTokenError) {
    super(code, status, oauthError)
    this.name = 'MicrosoftCalendarError'
  }
}

const text = z.string().min(1).max(1024).refine(isSingleLineText)
const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  refresh_token: z.string().min(1).max(8192).optional(),
  expires_in: z.number().int().positive().max(31_536_000),
  token_type: z.literal('Bearer'),
  scope: z.string().max(8192).optional(),
})
const identitySchema = z.object({ sub: text, email: z.email().max(320).nullish() })
const calendarPage = z.object({
  '@odata.nextLink': z.string().min(1).max(16_384).optional(),
  value: z
    .array(
      z.object({
        id: text,
        name: text,
        isDefaultCalendar: z.boolean().optional(),
        canEdit: z.boolean().optional(),
        canViewPrivateItems: z.boolean().optional(),
      }),
    )
    .max(250),
})

/** Refresh tokens establish continuing access; offline_access need not be echoed in scope. */
export function hasMicrosoftCalendarListAccess(scopes: readonly string[] | undefined) {
  return (
    scopes?.some((s) =>
      ['Calendars.ReadBasic', 'Calendars.Read', 'Calendars.ReadWrite'].includes(s),
    ) ?? false
  )
}

export function createMicrosoftCalendarClient(
  config: { clientId: string; clientSecret: string; publicUrl: string },
  request: typeof fetch = fetch,
) {
  const redirectUri = new URL(MICROSOFT_CALENDAR_CALLBACK, config.publicUrl).href
  const tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
  const calendarsUrl = 'https://graph.microsoft.com/v1.0/me/calendars'

  async function json(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await request(url, { ...init, signal, redirect: 'error' })
      if (!response.ok) {
        const tokenEndpoint = url === tokenUrl
        const oauthError = tokenEndpoint ? await readOAuthTokenError(response) : undefined
        if (!tokenEndpoint) await response.body?.cancel()
        throw new MicrosoftCalendarError(
          tokenEndpoint
            ? oauthError !== undefined &&
              ['invalid_grant', 'interaction_required', 'consent_required'].includes(oauthError) &&
              [400, 401].includes(response.status)
              ? 'needs_reauth'
              : 'provider_unavailable'
            : response.status === 401
              ? 'needs_reauth'
              : response.status === 403
                ? 'permissions_missing'
                : 'provider_unavailable',
          response.status,
          oauthError,
        )
      }
      if (!response.body) throw new MicrosoftCalendarError('provider_unavailable')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 262_144) throw new MicrosoftCalendarError('provider_unavailable')
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch (error) {
      if (error instanceof MicrosoftCalendarError) throw error
      throw new MicrosoftCalendarError('provider_unavailable')
    }
  }

  async function token(body: Record<string, string>, signal: AbortSignal): Promise<CalendarTokens> {
    const parsed = tokenSchema.safeParse(
      await json(
        tokenUrl,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            ...body,
            client_id: config.clientId,
            client_secret: config.clientSecret,
            scope: MICROSOFT_CALENDAR_SCOPES.join(' '),
          }),
        },
        signal,
      ),
    )
    if (!parsed.success) throw new MicrosoftCalendarError('provider_unavailable')
    const t = parsed.data
    // Microsoft's successful code response may omit scope when it matches the initial
    // request. An explicitly empty/partial scope is still authoritative. Refresh responses
    // without scope keep the connection's previously recorded grant in the service layer.
    const scope =
      t.scope ??
      (body.grant_type === 'authorization_code' ? MICROSOFT_CALENDAR_SCOPES.join(' ') : undefined)
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000,
      scopes: scope
        ?.split(/\s+/)
        .filter(Boolean)
        .map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//, '')),
    }
  }

  return {
    authorizationUrl(state: string, verifier: string, access: 'list' | 'sync' = 'list') {
      if (access !== 'list') throw new MicrosoftCalendarError('permissions_missing')
      const url = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'query',
        scope: MICROSOFT_CALENDAR_SCOPES.join(' '),
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        prompt: 'consent',
      }).toString()
      return url.href
    },
    exchange(code: string, verifier: string, signal: AbortSignal) {
      return token(
        {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        },
        signal,
      )
    },
    refresh(refreshToken: string, signal: AbortSignal) {
      return token({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal)
    },
    async identity(accessToken: string, signal: AbortSignal) {
      const parsed = identitySchema.safeParse(
        await json(
          'https://graph.microsoft.com/oidc/userinfo',
          {
            headers: { authorization: `Bearer ${accessToken}` },
          },
          signal,
        ),
      )
      if (!parsed.success) throw new MicrosoftCalendarError('provider_unavailable')
      // Email is display metadata, never an account identifier or sign-in proof.
      return { id: parsed.data.sub, email: parsed.data.email ?? null }
    },
    async calendars(accessToken: string, signal: AbortSignal): Promise<ProviderCalendar[]> {
      const calendars: ProviderCalendar[] = []
      const seen = new Set<string>()
      let next = new URL(calendarsUrl)
      next.searchParams.set('$top', '250')
      next.searchParams.set('$select', 'id,name,isDefaultCalendar,canEdit,canViewPrivateItems')
      for (let page = 0; page < 20; page++) {
        // Provider paging URLs carry the access token only to this exact official resource.
        if (
          next.origin !== 'https://graph.microsoft.com' ||
          next.pathname !== '/v1.0/me/calendars' ||
          next.username ||
          next.password ||
          next.hash ||
          seen.has(next.href)
        )
          throw new MicrosoftCalendarError('provider_unavailable')
        seen.add(next.href)
        const parsed = calendarPage.safeParse(
          await json(next.href, { headers: { authorization: `Bearer ${accessToken}` } }, signal),
        )
        if (!parsed.success) throw new MicrosoftCalendarError('provider_unavailable')
        for (const c of parsed.data.value)
          calendars.push({
            id: c.id,
            name: c.name,
            isPrimary: c.isDefaultCalendar ?? false,
            accessRole: c.canEdit
              ? c.canViewPrivateItems
                ? 'writer'
                : 'writerWithoutPrivateAccess'
              : 'reader',
            timeZone: null,
          })
        if (calendars.length > 2000) throw new MicrosoftCalendarError('provider_unavailable')
        const link = parsed.data['@odata.nextLink']
        if (!link) {
          if (new Set(calendars.map((c) => c.id)).size !== calendars.length)
            throw new MicrosoftCalendarError('provider_unavailable')
          return calendars
        }
        try {
          next = new URL(link)
        } catch {
          throw new MicrosoftCalendarError('provider_unavailable')
        }
      }
      throw new MicrosoftCalendarError('provider_unavailable')
    },
  }
}

export type MicrosoftCalendarClient = ReturnType<typeof createMicrosoftCalendarClient>
