import { isUuid } from './organizations.ts'

export type ApiKeyScope = 'full' | 'read' | 'bookings'

export const isApiKeyScope = (value: unknown): value is ApiKeyScope =>
  value === 'full' || value === 'read' || value === 'bookings'

/** Persisted credentials have no legacy default: the migration supplies it exactly once. */
export function parsePersistedApiKeyMetadata(
  value: string | null,
): { organizationId?: string; scope: ApiKeyScope } | null {
  let metadata: unknown
  try {
    metadata = value === null ? null : JSON.parse(value)
  } catch {
    return null
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null
  const record = metadata as Record<string, unknown>
  if (!isApiKeyScope(record.scope)) return null
  // Preserve the existing personal fallback for absent/non-string legacy organization data.
  if (typeof record.organizationId === 'string' && !isUuid(record.organizationId)) return null
  return {
    ...(typeof record.organizationId === 'string' ? { organizationId: record.organizationId } : {}),
    scope: record.scope,
  }
}
