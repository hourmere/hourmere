import type { Schemas } from '../../api/client.ts'

export type SsoProvider = Schemas['SsoProviderPage']['data'][number]
export type SsoDomain = SsoProvider['domains'][number]

export type SsoMutation = <T>(
  write: (signal: AbortSignal) => Promise<T>,
  onSuccess: (result: T) => void,
) => Promise<void>
