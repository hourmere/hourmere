import { createHash } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import { isSingleLineText } from '@hourmere/scheduling/text'
import { z } from 'zod'
import { microsoftEventMethods } from './microsoft-events.ts'
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
  'https://graph.microsoft.com/Calendars.ReadWrite',
] as const

export class MicrosoftCalendarError extends CalendarProviderError {
  readonly retryAfterMs: number | undefined

  constructor(
    code: CalendarProviderError['code'],
    status?: number,
    oauthError?: OAuthTokenError,
    retryAfterMs?: number,
  ) {
    super(code, status, oauthError)
    this.name = 'MicrosoftCalendarError'
    this.retryAfterMs = retryAfterMs
  }
}

export class MicrosoftDeltaReset extends MicrosoftCalendarError {
  constructor(status: number) {
    super('provider_unavailable', status)
    this.name = 'MicrosoftDeltaReset'
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
        canShare: z.boolean().optional(),
        canViewPrivateItems: z.boolean().optional(),
      }),
    )
    .max(250),
})

// Graph returns offset-free dateTime strings in the requested UTC time zone.
export const graphUtcTime = z.object({
  dateTime: z
    .string()
    .regex(/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,7})?(?:Z|\+00:00)?$/u),
  timeZone: z.literal('UTC'),
})
const graphOrigin = 'https://graph.microsoft.com'
const graphDeltaPageSize = 50
const deltaLink = z.string().min(1).max(16_384)
const graphDeltaPage = z.object({
  '@odata.nextLink': deltaLink.optional(),
  '@odata.deltaLink': deltaLink.optional(),
  value: z.array(z.unknown()).max(250),
})
const graphRemoved = z.object({
  id: text,
  '@removed': z.object({ reason: z.enum(['deleted', 'changed']) }),
})
const graphEvent = z.object({
  id: text,
  '@removed': z.undefined().optional(),
  type: z.enum(['singleInstance', 'occurrence', 'exception', 'seriesMaster']),
  seriesMasterId: text.nullish(),
  originalStart: z.iso.datetime({ offset: true }).nullish(),
  lastModifiedDateTime: z.iso.datetime({ offset: true }).nullish(),
  isCancelled: z.boolean(),
  start: graphUtcTime.optional(),
  end: graphUtcTime.optional(),
  isAllDay: z.boolean().optional(),
  showAs: z.enum(['free', 'tentative', 'busy', 'oof', 'workingElsewhere', 'unknown']).optional(),
})

export type MicrosoftDeltaChange =
  | { kind: 'removed'; id: string }
  | {
      kind: 'event'
      id: string
      type: z.infer<typeof graphEvent>['type']
      seriesMasterId: string | null
      originalStart: string | null
      lastModifiedAt?: string
      cancelled: boolean
      period: { start: Temporal.Instant; end: Temporal.Instant } | null
    }

export type MicrosoftDeltaPage = { changes: MicrosoftDeltaChange[] } & (
  | { nextLink: string; deltaLink?: never }
  | { nextLink?: never; deltaLink: string }
)

function eventPeriod(event: z.infer<typeof graphEvent>) {
  if (event.type === 'seriesMaster' || event.isCancelled) return null
  if (!event.showAs) throw new MicrosoftCalendarError('provider_unavailable')
  if (event.showAs === 'free' || event.showAs === 'workingElsewhere') return null
  if (!event.start || !event.end || event.isAllDay === undefined)
    throw new MicrosoftCalendarError('provider_unavailable')
  // Keep both UTC instants for all-day events. Midnight in the original time zone
  // can be non-midnight in UTC, and a DST transition can shorten or lengthen the day.
  const start = graphInstant(event.start.dateTime)
  const end = graphInstant(event.end.dateTime)
  const order = Temporal.Instant.compare(start, end)
  if (order > 0 || (order === 0 && event.isAllDay))
    throw new MicrosoftCalendarError('provider_unavailable')
  return order === 0 ? null : { start, end }
}

function deltaChange(value: unknown): MicrosoftDeltaChange {
  const removed = graphRemoved.safeParse(value)
  if (removed.success) return { kind: 'removed', id: removed.data.id }
  const event = graphEvent.safeParse(value)
  if (!event.success) throw new MicrosoftCalendarError('provider_unavailable')
  const { id, type, seriesMasterId, originalStart, isCancelled, lastModifiedDateTime } = event.data
  if ((type === 'occurrence' || type === 'exception') && (!seriesMasterId || !originalStart))
    throw new MicrosoftCalendarError('provider_unavailable')
  return {
    kind: 'event',
    id,
    type,
    seriesMasterId: seriesMasterId ?? null,
    originalStart: originalStart ? graphInstant(originalStart).toString() : null,
    ...(lastModifiedDateTime && { lastModifiedAt: graphInstant(lastModifiedDateTime).toString() }),
    cancelled: isCancelled,
    period: eventPeriod(event.data),
  }
}

export function graphInstant(value: string) {
  try {
    return Temporal.Instant.from(/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ? value : `${value}Z`)
  } catch {
    throw new MicrosoftCalendarError('provider_unavailable')
  }
}

function validateDeltaUrl(link: string, calendarId: string): URL {
  try {
    const url = new URL(link)
    const segment = /^\/v1\.0\/me\/calendars\/([^/]+)\/calendarView\/delta(?:\(\))?$/u.exec(
      url.pathname,
    )?.[1]
    // Graph can return the same calendar ID with different URL encoding in the links.
    if (
      url.origin === graphOrigin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      segment !== undefined &&
      decodeURIComponent(segment) === calendarId
    )
      return url
  } catch {
    // Keep malformed URLs and state tokens out of errors.
  }
  throw new MicrosoftCalendarError('provider_unavailable')
}

async function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  using _listener = addAbortListener(signal, () =>
    aborted.reject(new MicrosoftCalendarError('provider_unavailable')),
  )
  return await Promise.race([aborted.promise, work()])
}

async function readJsonBody(response: Response, signal: AbortSignal, limit: number) {
  if (!response.body) throw new MicrosoftCalendarError('provider_unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await abortable(signal, () => reader.read())
      if (done) break
      size += value.byteLength
      if (size > limit) throw new MicrosoftCalendarError('provider_unavailable')
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function isSyncStateNotFound(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('error' in value)) return false
  let error = value.error
  while (error && typeof error === 'object') {
    if (
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.toLowerCase() === 'syncstatenotfound'
    )
      return true
    error =
      'innerError' in error
        ? error.innerError
        : 'innererror' in error
          ? error.innererror
          : undefined
  }
  return false
}

function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined
  const maximum = 24 * 60 * 60 * 1000
  if (/^\d+$/u.test(value)) return Math.min(maximum, Number(value) * 1000)
  const date = new Date(value)
  if (date.toUTCString() === value) return Math.min(maximum, Math.max(0, date.getTime() - now))
}

/** Refresh tokens establish continuing access; offline_access need not be echoed in scope. */
export function hasMicrosoftCalendarListAccess(scopes: readonly string[] | undefined) {
  return (
    scopes?.some((s) =>
      ['Calendars.ReadBasic', 'Calendars.Read', 'Calendars.ReadWrite'].includes(s),
    ) ?? false
  )
}

export function hasMicrosoftCalendarWriteAccess(scopes: readonly string[] | undefined) {
  return scopes?.includes('Calendars.ReadWrite') ?? false
}

export function createMicrosoftCalendarClient(
  config: { clientId: string; clientSecret: string; publicUrl: string },
  request: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const redirectUri = new URL(MICROSOFT_CALENDAR_CALLBACK, config.publicUrl).href
  const tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
  const calendarsUrl = `${graphOrigin}/v1.0/me/calendars`

  async function json(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    deltaRead = false,
  ): Promise<unknown> {
    try {
      const send = () => request(url, { ...init, signal, redirect: 'error' })
      let response = await abortable(signal, send)
      if (deltaRead && response.status === 429) {
        const wait = retryAfterMs(response.headers.get('Retry-After'), now())
        // Long or unspecified backoff belongs to the caller's background retry schedule.
        if (wait !== undefined && wait <= 10_000) {
          void response.body?.cancel().catch(() => {})
          await setTimeout(wait, undefined, { signal })
          response = await abortable(signal, send)
        }
      }
      if (!response.ok) {
        if (deltaRead) {
          if (response.status === 410) {
            void response.body?.cancel().catch(() => {})
            throw new MicrosoftDeltaReset(response.status)
          }
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            const error = await readJsonBody(response, signal, 4096).catch(() => undefined)
            if (isSyncStateNotFound(error)) throw new MicrosoftDeltaReset(response.status)
          }
        }
        const tokenEndpoint = url === tokenUrl
        const oauthError = tokenEndpoint
          ? await abortable(signal, () => readOAuthTokenError(response))
          : undefined
        if (!tokenEndpoint) void response.body?.cancel().catch(() => {})
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
          response.status === 429 || response.status === 503
            ? retryAfterMs(response.headers.get('Retry-After'), now())
            : undefined,
        )
      }
      if (init.method === 'DELETE') {
        if (response.status === 204) return
        void response.body?.cancel().catch(() => {})
        throw new MicrosoftCalendarError('provider_unavailable')
      }
      // Delta does not support $select. Retain a byte cap for its larger event objects.
      return await readJsonBody(response, signal, deltaRead ? 1_048_576 : 262_144)
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
    const scope = t.scope ?? (body.grant_type === 'authorization_code' ? body.scope : undefined)
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: now() + t.expires_in * 1000,
      scopes: scope
        ?.split(/\s+/)
        .filter(Boolean)
        .map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//, '')),
    }
  }

  return {
    ...microsoftEventMethods(json),
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
          scope: MICROSOFT_CALENDAR_SCOPES.join(' '),
        },
        signal,
      )
    },
    refresh(refreshToken: string, signal: AbortSignal, grantedScopes: readonly string[]) {
      return token(
        {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          // Microsoft does not echo offline_access in the granted scope, but a refresh without it
          // may return no new refresh token. Keep asking for it within the existing grant.
          scope: [...new Set([...grantedScopes, 'offline_access'])].join(' '),
        },
        signal,
      )
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
      next.searchParams.set(
        '$select',
        'id,name,isDefaultCalendar,canEdit,canShare,canViewPrivateItems',
      )
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
            // Graph reserves canShare for the calendar creator, even when delegates can edit.
            accessRole: !c.canEdit
              ? 'reader'
              : c.canShare
                ? 'owner'
                : c.canViewPrivateItems
                  ? 'writer'
                  : 'writerWithoutPrivateAccess',
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
    async deltaEvents(
      accessToken: string,
      calendarId: string,
      {
        start,
        end,
        link,
      }: { start: Temporal.Instant; end: Temporal.Instant; link?: string | undefined },
      signal: AbortSignal,
    ): Promise<MicrosoftDeltaPage> {
      if (
        !text.safeParse(calendarId).success ||
        !calendarId.isWellFormed() ||
        Temporal.Instant.compare(start, end) >= 0
      )
        throw new MicrosoftCalendarError('provider_unavailable')

      const url = validateDeltaUrl(
        link ?? `${calendarsUrl}/${encodeURIComponent(calendarId)}/calendarView/delta`,
        calendarId,
      )
      if (link === undefined) {
        url.searchParams.set('startDateTime', start.toString())
        url.searchParams.set('endDateTime', end.toString())
      }
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      const headers = {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        prefer: `outlook.timezone="UTC", odata.maxpagesize=${graphDeltaPageSize}`,
      }
      const parsed = graphDeltaPage.safeParse(await json(url.href, { headers }, deadline, true))
      if (!parsed.success) throw new MicrosoftCalendarError('provider_unavailable')
      const next = parsed.data['@odata.nextLink']
      const delta = parsed.data['@odata.deltaLink']
      if (next && !delta) {
        if (validateDeltaUrl(next, calendarId).href === url.href)
          throw new MicrosoftCalendarError('provider_unavailable')
        return { nextLink: next, changes: parsed.data.value.map(deltaChange) }
      }
      if (delta && !next) {
        validateDeltaUrl(delta, calendarId)
        return { deltaLink: delta, changes: parsed.data.value.map(deltaChange) }
      }
      throw new MicrosoftCalendarError('provider_unavailable')
    },
  }
}

export type MicrosoftCalendarClient = ReturnType<typeof createMicrosoftCalendarClient>
