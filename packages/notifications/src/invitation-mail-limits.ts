import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import {
  invitationRecipientHash,
  lockNotificationEmailBudget,
  type NotificationMailLimits,
} from './mail-limits.ts'

export interface InvitationMailLimits extends NotificationMailLimits {
  invitationInviterMaxPerHour?: number | undefined
  invitationInviterMaxPerDay?: number | undefined
  invitationTeamMaxPerHour?: number | undefined
  invitationTeamMaxPerDay?: number | undefined
}

/** Read current admission capacity without locking or consuming a request slot. */
export async function invitationEmailBudgetAvailable(
  db: Db,
  invitation: { userId: string; organizationId: string; email: string },
  deps: InvitationMailLimits & { secret: string },
  /** The summary passes the same database time used for invitation expiry. */
  at?: Date,
): Promise<boolean> {
  const now =
    at ?? (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db)).rows[0]?.now
  if (!now) throw new Error('Invitation mail eligibility needs the database clock')
  const hour = new Date(now.getTime() - 3_600_000)
  const day = new Date(now.getTime() - 86_400_000)
  const hash = invitationRecipientHash(invitation.email, deps.secret)
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
      eb.fn.countAll<string>().filterWhere('recipient_hash', '=', hash).as('recipientDay'),
      eb.fn
        .countAll<string>()
        .filterWhere('recipient_hash', '=', hash)
        .filterWhere('requested_at', '>', hour)
        .as('recipientHour'),
    ])
    .where('requested_at', '>', day)
    .where((eb) =>
      eb.or([
        eb('user_id', '=', invitation.userId),
        eb('organization_id', '=', invitation.organizationId),
        eb('recipient_hash', '=', hash),
      ]),
    )
    .executeTakeFirstOrThrow()
  if (
    Number(counts.inviterHour) >= (deps.invitationInviterMaxPerHour ?? 20) ||
    Number(counts.inviterDay) >= (deps.invitationInviterMaxPerDay ?? 100) ||
    Number(counts.teamHour) >= (deps.invitationTeamMaxPerHour ?? 50) ||
    Number(counts.teamDay) >= (deps.invitationTeamMaxPerDay ?? 200) ||
    Number(counts.recipientHour) >= (deps.mailRecipientMaxPerHour ?? 5) ||
    Number(counts.recipientDay) >= (deps.mailRecipientMaxPerDay ?? 20)
  )
    return false
  return true
}

/**
 * Admit one creation/resend in the transaction that writes its delivery intent.
 * Admission counts requests, independently of SMTP sends, and never consumes guest-mail
 * capacity. Retries of the same generation do not spend another admission slot.
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
  if (!(await invitationEmailBudgetAvailable(db, invitation, deps, now))) return false
  const hash = invitationRecipientHash(invitation.email, deps.secret)
  await db
    .insertInto('invitation_email_requests')
    .values({
      user_id: invitation.userId,
      organization_id: invitation.organizationId,
      recipient_hash: hash,
      requested_at: now,
    })
    .execute()
  return true
}
