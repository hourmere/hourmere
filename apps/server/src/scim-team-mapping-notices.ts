import { localeCodes } from '@hourmere/core/language'
import type { Db } from '@hourmere/db'
import { type AuditActor, writeAuditEvent } from '@hourmere/db/audit'
import { defineJob, type EnqueueOptions } from '@hourmere/jobs'
import { type Mailer, scimMappingEmail } from '@hourmere/mail'
import { z } from 'zod'
import { type MailboxProofDeliveryDeps, mailboxProofJobs } from './sso-mailbox-proof.ts'
import { ssoRecoveryNoticeLanguage, ssoRecoveryTeamOwners } from './sso-recovery-enrollment.ts'

const name = 'scim-team-mapping-owner-email'
const payload = z.strictObject({
  organizationId: z.uuid(),
  userId: z.uuid(),
  mappingId: z.uuid(),
  action: z.enum(['linked', 'unlinked', 'suspended']),
  language: z.enum(localeCodes),
})
type Notice = z.infer<typeof payload>

export interface ScimMappingNoticeQueue {
  enqueue(job: typeof name, notice: Notice, options: EnqueueOptions): Promise<string | null>
}

export const scimMappingNoticeQueue = defineJob({ name, payload })

function verifiedOwners(db: Db, organizationId: string) {
  return ssoRecoveryTeamOwners(db, organizationId)
    .innerJoin('auth.user', 'auth.user.id', 'auth.member.userId')
    .where('auth.user.emailVerified', '=', true)
}

export function scimMappingNoticeJob(db: Db, mailer: Mailer) {
  return defineJob({
    ...scimMappingNoticeQueue,
    handler: async ({ organizationId, userId, mappingId, action, language }, { signal }) => {
      try {
        const owner = await verifiedOwners(db, organizationId)
          .select('auth.user.email')
          .where('auth.member.userId', '=', userId)
          .executeTakeFirst()
        if (owner)
          await mailer.send(scimMappingEmail(owner.email, language, action, mappingId), { signal })
      } catch {
        throw new Error('SCIM mapping owner email could not be sent')
      }
    },
  })
}

/** Use in the resource-test worker instead of the ordinary mailbox-proof job definitions. */
export function scimMappingResourceJobs(deps: MailboxProofDeliveryDeps) {
  return [
    ...mailboxProofJobs({ ...deps, scimMappingConsentEnabled: true }),
    scimMappingNoticeJob(deps.db, deps.mailer),
  ] as const
}

export async function recordScimMappingChange(
  trx: Db,
  queue: ScimMappingNoticeQueue | undefined,
  mappingId: string,
  action: Notice['action'],
  teams: { organizationId: string; actor: AuditActor }[],
) {
  if (!queue) throw new Error('SCIM mapping owner notice queue is unavailable')
  for (const { organizationId, actor } of teams) {
    await writeAuditEvent(trx, {
      organizationId,
      actor,
      credential: { type: 'none' },
      action: `scim_mapping.${action}`,
      targetType: 'scim_mapping',
      targetId: mappingId,
    })
    const owners = await verifiedOwners(trx, organizationId).execute()
    for (const { userId, locale } of owners) {
      const job = await queue.enqueue(
        name,
        { organizationId, userId, mappingId, action, language: ssoRecoveryNoticeLanguage(locale) },
        { transaction: trx },
      )
      if (!job) throw new Error('SCIM mapping owner email could not be queued')
    }
  }
}
