import { api, type Schemas, unwrap } from '../../api/client.ts'
import type { MessageKey } from '../../i18n/translate.ts'

export type SsoProvider = Schemas['SsoProviderPage']['data'][number]
export type SsoDomain = SsoProvider['domains'][number]

export async function loadSsoProviders(organizationId: string, signal: AbortSignal) {
  const providers: SsoProvider[] = []
  let cursor: string | null = null
  do {
    const page: Schemas['SsoProviderPage'] = await unwrap(
      api.GET('/api/v1/team/sso/providers', {
        headers: { 'X-Expected-Organization-Id': organizationId },
        params: { query: { limit: '100', ...(cursor ? { cursor } : {}) } },
        signal,
        cache: 'no-store',
      }),
    )
    providers.push(...page.data)
    cursor = page.nextCursor
  } while (cursor)
  return providers
}

export type SsoProofChallenge = Required<
  Pick<Schemas['SsoFreshProofChallenge'], 'attemptId' | 'proofMethods' | 'expiresAt'>
>

export class SsoProofRequired extends Error {
  readonly challenge: SsoProofChallenge

  constructor(challenge: SsoProofChallenge) {
    super('sso_reauthentication_required')
    this.challenge = challenge
  }
}

export function ssoAuthorizationUrl(raw: string): string {
  const url = new URL(raw)
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password
  )
    throw new Error('Invalid identity provider destination')
  return url.href
}

export async function unwrapSsoWrite<T>(call: Parameters<typeof unwrap<T>>[0]): Promise<T> {
  const result = await call
  const error = result.error as Partial<Schemas['SsoFreshProofChallenge']> | undefined
  if (
    result.response.status === 403 &&
    error?.error === 'sso_reauthentication_required' &&
    typeof error.attemptId === 'string' &&
    error.attemptId.length > 0 &&
    typeof error.expiresAt === 'string' &&
    Number.isFinite(Date.parse(error.expiresAt)) &&
    Array.isArray(error.proofMethods) &&
    error.proofMethods.every((method) => typeof method === 'string')
  ) {
    throw new SsoProofRequired({
      attemptId: error.attemptId,
      expiresAt: error.expiresAt,
      proofMethods: error.proofMethods,
    })
  }
  return unwrap(Promise.resolve(result))
}

export type SsoMutation = <T>(
  write: (signal: AbortSignal, proofAttemptId?: string) => Promise<T>,
  onSuccess: (result: T) => void,
  messages?: Readonly<Record<string, MessageKey>>,
) => Promise<void>
