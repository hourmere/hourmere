import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { parsePersistedApiKeyMetadata } from './api-key-metadata.ts'
import type { Principal } from './caller.ts'

/** A credential revoked after request resolution has the same response as an invalid key. */
export class InvalidApiKeyError extends Error {
  constructor() {
    super('Invalid API key')
    this.name = 'InvalidApiKeyError'
  }
}

/** Call inside the write transaction, after locking the user and before changing settings. */
export async function requireActiveApiKey(
  db: Db,
  principal: Extract<Principal, { kind: 'api_key' }>,
  now: number | (() => number),
) {
  // Hold the key against deletion, disabling and reassignment until the write commits.
  const key = await db
    .selectFrom('auth.apikey')
    .select(['metadata', 'expiresAt'])
    .where('id', '=', principal.apiKeyId)
    .where('referenceId', '=', principal.user.id)
    .where(sql<boolean>`enabled IS DISTINCT FROM false`)
    .forShare()
    .executeTakeFirst()
  if (!key) throw new InvalidApiKeyError()
  const checkedAt = typeof now === 'function' ? now() : now
  if (key.expiresAt !== null && key.expiresAt.getTime() <= checkedAt) throw new InvalidApiKeyError()
  const metadata = parsePersistedApiKeyMetadata(key.metadata)
  if (!metadata || metadata.scope !== principal.apiKeyScope) throw new InvalidApiKeyError()
  // Match resolution's legacy fallback without creating an organization during a write.
  const organizationId =
    typeof metadata?.organizationId === 'string'
      ? metadata.organizationId
      : (
          await db
            .selectFrom('personal_organizations')
            .select('organization_id')
            .where('user_id', '=', principal.user.id)
            .executeTakeFirst()
        )?.organization_id
  if (organizationId?.toLowerCase() !== principal.organization.id.toLowerCase())
    throw new InvalidApiKeyError()
}
