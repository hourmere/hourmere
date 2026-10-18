/** Provider-independent connection metadata. Event synchronization has its own adapters. */
export interface CalendarTokens {
  accessToken: string
  refreshToken?: string | undefined
  expiresAt: number
  scopes?: string[] | undefined
}

export interface ProviderCalendar {
  id: string
  name: string
  isPrimary: boolean
  accessRole: 'freeBusyReader' | 'reader' | 'writer' | 'writerWithoutPrivateAccess' | 'owner'
  supportsGoogleMeet?: boolean
  timeZone: string | null
}

export type CalendarProvider = 'google' | 'microsoft'

const oauthTokenErrors = [
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'invalid_client',
  'unauthorized_client',
  'invalid_request',
  'invalid_scope',
  'unsupported_grant_type',
  'server_error',
  'temporarily_unavailable',
] as const
export type OAuthTokenError = (typeof oauthTokenErrors)[number]

/** Only this allow-listed field may leave a bounded token error response. */
export async function readOAuthTokenError(
  response: Response,
): Promise<OAuthTokenError | undefined> {
  if (!response.body) return undefined
  const reader = response.body.getReader()
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) return undefined
      chunks.push(value)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof body !== 'object' || body === null || !('error' in body)) return undefined
    const error = body.error
    return oauthTokenErrors.find((allowed) => allowed === error)
  } catch {
    return undefined
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** Safe, bounded error codes: never retain upstream response bodies or credentials. */
export class CalendarProviderError extends Error {
  readonly code: 'provider_unavailable' | 'needs_reauth' | 'permissions_missing'
  readonly status: number | undefined
  readonly oauthError: OAuthTokenError | undefined

  constructor(code: CalendarProviderError['code'], status?: number, oauthError?: OAuthTokenError) {
    super(oauthError ? `${code} (${oauthError})` : code)
    this.name = 'CalendarProviderError'
    this.code = code
    this.status = status
    this.oauthError = oauthError
  }
}
