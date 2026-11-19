import type { Db } from '@hourmere/db'
import { auditActor, type SsoAuditReason, writeSsoAuditEvent } from '@hourmere/db/audit'
import { sql } from 'kysely'
import type { SsoProviderRevision } from './sso-configuration.ts'
import { lockOidcTestActor, OidcAttemptRefused, type OidcTestActor } from './sso-oidc-attempt.ts'

const action = 'sso_provider.tested'

/** A receipt only applies to the revision whose sealed configuration was tested. */
export const currentSsoProviderTestStatus = sql<string>`coalesce((
  SELECT details->>'outcome' FROM audit_events
  WHERE organization_id = sso_providers.organization_id
    AND action = ${action} AND target_id = sso_providers.id::text
    AND details->'revision' = to_jsonb(sso_providers.revision)
  ORDER BY occurred_at DESC, id DESC LIMIT 1
), 'unknown')`

export async function recordOidcProviderTest(
  db: Db,
  provider: SsoProviderRevision,
  actor: OidcTestActor,
  attempt: { id: string; expiresAt: Date },
  reason?: SsoAuditReason,
) {
  await db.transaction().execute(async (trx) => {
    const role = await lockOidcTestActor(trx, provider, actor)
    const { live } = await trx
      .selectNoFrom(sql<boolean>`${attempt.expiresAt}::timestamptz > clock_timestamp()`.as('live'))
      .executeTakeFirstOrThrow()
    if (!live) throw new OidcAttemptRefused()
    await writeSsoAuditEvent(trx, {
      ...auditActor({ kind: 'session', user: { id: actor.userId }, sessionId: actor.id }),
      organizationId: provider.organizationId,
      action,
      // Keep the role at the time of the test even if the actor is promoted later.
      targetType: role === 'owner' ? 'sso_provider_owner_test' : 'sso_provider',
      targetId: provider.providerId,
      details: {
        method: 'oidc',
        providerId: provider.providerId,
        revision: provider.revision,
        correlationId: attempt.id,
        outcome: reason === undefined ? 'passed' : 'failed',
        ...(reason !== undefined && { reason }),
      },
    })
  })
}
