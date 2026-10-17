import { createHash } from 'node:crypto'
import { isSingleLineText } from '@hourmere/scheduling/text'
import { z } from 'zod'

export const GOOGLE_CALENDAR_CALLBACK = '/api/calendar/google/callback'
export const GOOGLE_CALENDAR_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const

export class GoogleCalendarError extends Error {
  readonly code: 'provider_unavailable' | 'needs_reauth' | 'permissions_missing'
  constructor(code: 'provider_unavailable' | 'needs_reauth' | 'permissions_missing') {
    super(code)
    this.name = 'GoogleCalendarError'
    this.code = code
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
const userSchema = z.object({
  sub: text,
  email: z.email().max(320),
  email_verified: z.literal(true),
})
const calendarPage = z.object({
  nextPageToken: z.string().min(1).max(4096).optional(),
  items: z
    .array(z.object({ id: text, summary: text.optional(), primary: z.boolean().optional() }))
    .max(250)
    .optional(),
})
export interface GoogleTokens {
  accessToken: string
  refreshToken?: string | undefined
  expiresAt: number
  scopes?: string[] | undefined
}
export interface GoogleCalendar {
  id: string
  name: string
  isPrimary: boolean
}
export interface GoogleCalendarConfig {
  clientId: string
  clientSecret: string
  publicUrl: string
}

/** Fixed official endpoints; neither the user nor a provider response chooses a host. */
export function createGoogleCalendarClient(
  config: GoogleCalendarConfig,
  request: typeof fetch = fetch,
) {
  const redirectUri = new URL(GOOGLE_CALENDAR_CALLBACK, config.publicUrl).href

  async function json(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await request(url, { ...init, signal, redirect: 'error' })
      if (!response.ok) {
        // Do not read or log upstream error bodies: they can echo codes and tokens.
        await response.body?.cancel()
        throw new GoogleCalendarError(
          response.status === 401 || response.status === 400
            ? 'needs_reauth'
            : 'provider_unavailable',
        )
      }
      if (!response.body) throw new GoogleCalendarError('provider_unavailable')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          length += value.byteLength
          if (length > 262_144) throw new GoogleCalendarError('provider_unavailable')
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch (error) {
      if (error instanceof GoogleCalendarError) throw error
      throw new GoogleCalendarError('provider_unavailable')
    }
  }

  async function token(body: Record<string, string>, signal: AbortSignal): Promise<GoogleTokens> {
    const result = tokenSchema.safeParse(
      await json(
        'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            ...body,
            client_id: config.clientId,
            client_secret: config.clientSecret,
          }),
        },
        signal,
      ),
    )
    if (!result.success) throw new GoogleCalendarError('provider_unavailable')
    const t = result.data
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000,
      scopes: t.scope
        ?.split(/\s+/)
        .filter(Boolean)
        .map((s) => (s === 'https://www.googleapis.com/auth/userinfo.email' ? 'email' : s)),
    }
  }

  return {
    authorizationUrl(state: string, verifier: string) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_CALENDAR_SCOPES.join(' '),
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'false',
      }).toString()
      return url.href
    },
    exchange(code: string, verifier: string, signal: AbortSignal) {
      return token(
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        },
        signal,
      )
    },
    refresh(refreshToken: string, signal: AbortSignal) {
      return token({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal)
    },
    async identity(accessToken: string, signal: AbortSignal) {
      const result = userSchema.safeParse(
        await json(
          'https://openidconnect.googleapis.com/v1/userinfo',
          { headers: { authorization: `Bearer ${accessToken}` } },
          signal,
        ),
      )
      if (!result.success) throw new GoogleCalendarError('provider_unavailable')
      return { id: result.data.sub, email: result.data.email }
    },
    async calendars(accessToken: string, signal: AbortSignal): Promise<GoogleCalendar[]> {
      const calendars: GoogleCalendar[] = []
      const seen = new Set<string>()
      let pageToken: string | undefined
      for (let page = 0; page < 20; page++) {
        const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList')
        url.search = new URLSearchParams({
          maxResults: '250',
          fields: 'items(id,summary,primary),nextPageToken',
          ...(pageToken && { pageToken }),
        }).toString()
        const result = calendarPage.safeParse(
          await json(url.href, { headers: { authorization: `Bearer ${accessToken}` } }, signal),
        )
        if (!result.success) throw new GoogleCalendarError('provider_unavailable')
        for (const item of result.data.items ?? [])
          calendars.push({
            id: item.id,
            name: item.summary ?? item.id,
            isPrimary: item.primary ?? false,
          })
        if (calendars.length > 2000) throw new GoogleCalendarError('provider_unavailable')
        pageToken = result.data.nextPageToken
        if (!pageToken) {
          if (new Set(calendars.map((c) => c.id)).size !== calendars.length)
            throw new GoogleCalendarError('provider_unavailable')
          return calendars
        }
        if (seen.has(pageToken)) throw new GoogleCalendarError('provider_unavailable')
        seen.add(pageToken)
      }
      throw new GoogleCalendarError('provider_unavailable')
    },
  }
}

export type GoogleCalendarClient = ReturnType<typeof createGoogleCalendarClient>
