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
  timeZone: string | null
}

export type CalendarProvider = 'google' | 'microsoft'

/** Safe, bounded error codes: never retain upstream response bodies or credentials. */
export class CalendarProviderError extends Error {
  readonly code: 'provider_unavailable' | 'needs_reauth' | 'permissions_missing'
  readonly status: number | undefined

  constructor(code: CalendarProviderError['code'], status?: number) {
    super(code)
    this.name = 'CalendarProviderError'
    this.code = code
    this.status = status
  }
}
