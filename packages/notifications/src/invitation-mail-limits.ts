import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import {
  invitationRecipientHash,
  lockNotificationEmailBudget,
  type NotificationMailLimits,
  notificationEmailBudget,
} from './mail-limits.ts'

export interface InvitationMailLimits extends NotificationMailLimits {
  invitationInviterMaxPerHour?: number | undefined
  invitationInviterMaxPerDay?: number | undefined
  invitationTeamMaxPerHour?: number | undefined
  invitationTeamMaxPerDay?: number | undefined
}

/**
 * Admit one creation/resend in the transaction that writes its delivery intent.
 * Admission reserves mail capacity once; a later sender must consume this existing
 * reservation rather than charge notification_email_sends a second time. Retries
 * of the same generation likewise do not reserve again.
 */
export async function reserveInvitationEmailBudget(
  db: Db,
  invitation: { userId: string; organizationId: string; email: string },
  deps: InvitationMailLimits & { secret: string },
  /** Optional deterministic clock for tests; production reads after the budget lock. */
  at?: Date,
): Promise<boolean> {
  if (!db.isTransaction) throw new Error('Invitation mail reservation needs a transaction')
  await lockNotificationEmailBudget(db)
  const now =
    at ?? (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db)).rows[0]?.now
  if (!now) throw new Error('Invitation mail reservation needs the database clock')
  const hour = new Date(now.getTime() - 3_600_000)
  const day = new Date(now.getTime() - 86_400_000)
  const counts = await db
    .selectFrom('invitation_email_requests')
    .select((eb) => [
      eb.fn.countAll<string>().filterWhere('user_id', '=', invitation.userId).as('inviterDay'),
      eb.fn
        .countAll<string>()
        .filterWhere('user_id', '=', invitation.userId)
        .filterWhere('requested_at', '>', hour)
        .as('inviterHour'),
      eb.fn
        .countAll<string>()
        .filterWhere('organization_id', '=', invitation.organizationId)
        .as('teamDay'),
      eb.fn
        .countAll<string>()
        .filterWhere('organization_id', '=', invitation.organizationId)
        .filterWhere('requested_at', '>', hour)
        .as('teamHour'),
    ])
    .where('requested_at', '>', day)
    .where((eb) =>
      eb.or([
        eb('user_id', '=', invitation.userId),
        eb('organization_id', '=', invitation.organizationId),
      ]),
    )
    .executeTakeFirstOrThrow()
  if (
    Number(counts.inviterHour) >= (deps.invitationInviterMaxPerHour ?? 20) ||
    Number(counts.inviterDay) >= (deps.invitationInviterMaxPerDay ?? 100) ||
    Number(counts.teamHour) >= (deps.invitationTeamMaxPerHour ?? 50) ||
    Number(counts.teamDay) >= (deps.invitationTeamMaxPerDay ?? 200)
  )
    return false
  const hash = invitationRecipientHash(invitation.email, deps.secret)
  // Invitations spend ordinary capacity only. Hosts/sign-in retain their reserve.
  if (await notificationEmailBudget(db, deps, hash, true, now)) return false
  await db
    .insertInto('invitation_email_requests')
    .values({
      user_id: invitation.userId,
      organization_id: invitation.organizationId,
      requested_at: now,
    })
    .execute()
  await db
    .insertInto('notification_email_sends')
    .values({ recipient_hash: hash, sent_at: now })
    .execute()
  return true
}
