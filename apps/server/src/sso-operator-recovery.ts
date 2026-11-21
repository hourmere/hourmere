import { localeCodes } from '@hourmere/core/language'
import type { Db } from '@hourmere/db'
import { writeSsoAuditEvent } from '@hourmere/db/audit'
import { defineJob, type EnqueueOptions } from '@hourmere/jobs'
import { type Mailer, ssoOperatorRecoveryEmail } from '@hourmere/mail'
import { z } from 'zod'
import { ssoRecoveryNoticeLanguage, ssoRecoveryTeamOwners } from './sso-recovery-enrollment.ts'

const name = 'sso-operator-recovery-email'
const payload = z.strictObject({
  organizationId: z.uuid(),
  userId: z.uuid(),
  language: z.enum(localeCodes),
})

// Unlike recovery ceremonies, operator maintenance can remove trust in every protocol state.
export const ssoOperatorRecoveryQueue = defineJob({ name, payload })

export function ssoOperatorRecoveryEmailJob(db: Db, mailer: Mailer | undefined) {
  return defineJob({
    ...ssoOperatorRecoveryQueue,
    handler: async ({ organizationId, userId, language }, { signal }) => {
      try {
        const owner = await ssoRecoveryTeamOwners(db, organizationId)
          .innerJoin('auth.user', 'auth.user.id', 'auth.member.userId')
          .select('auth.user.email')
          .where('auth.member.userId', '=', userId)
          .where('auth.user.emailVerified', '=', true)
          .executeTakeFirst()
        if (!owner) return
        if (!mailer) throw new Error('SMTP is unavailable')
        await mailer.send(ssoOperatorRecoveryEmail(owner.email, language), { signal })
      } catch {
        throw new Error(
          mailer
            ? 'SSO operator recovery email could not be sent'
            : 'SSO operator recovery email requires configured SMTP',
        )
      }
    },
  })
}

interface OperatorRecoveryQueue {
  enqueue(
    jobName: typeof name,
    notice: z.infer<typeof payload>,
    options: EnqueueOptions,
  ): Promise<string | null>
}

export function disableSsoEnforcement(
  db: Db,
  queue: OperatorRecoveryQueue,
  organizationId: string,
) {
  return db.transaction().execute(async (trx) => {
    // Same serialization point as setSsoPolicy, including when there is no policy row yet.
    const team = await trx
      .selectFrom('auth.organization')
      .select('id')
      .where('id', '=', organizationId)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('personal_organizations')
              .select('organization_id')
              .whereRef('organization_id', '=', 'auth.organization.id'),
          ),
        ),
      )
      .forUpdate()
      .executeTakeFirst()
    if (!team) return 'unknown_team'

    const policy = await trx
      .selectFrom('sso_policies')
      .select(['require_sso', 'policy_revision', 'trust_generation'])
      .where('organization_id', '=', team.id)
      .executeTakeFirst()
    if (!policy?.require_sso) return 'already_disabled'

    const revision = policy.policy_revision + 1
    await trx
      .updateTable('sso_policies')
      .set({
        require_sso: false,
        policy_revision: revision,
        trust_generation: policy.trust_generation + 1,
      })
      .where('organization_id', '=', team.id)
      .execute()
    await writeSsoAuditEvent(trx, {
      organizationId: team.id,
      actor: { type: 'system', id: 'sso-operator-recovery' },
      credential: { type: 'none' },
      action: 'sso_maintenance.enforcement_disabled',
      targetType: 'organization',
      targetId: team.id,
      details: { revision },
    })
    const owners = await ssoRecoveryTeamOwners(trx, team.id).execute()
    for (const { userId, locale } of owners) {
      const job = await queue.enqueue(
        name,
        {
          organizationId: team.id,
          userId,
          language: ssoRecoveryNoticeLanguage(locale),
        },
        { transaction: trx },
      )
      if (!job) throw new Error('SSO operator recovery email could not be queued')
    }
    return 'disabled'
  })
}
