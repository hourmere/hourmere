import type { InvitationEmailBudgetRequest } from '@hourmere/auth'
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
  scimInvitationMaxPerHour?: number | undefined
  scimInvitationMaxPerDay?: number | undefined
}

/** Read current admission capacity without locking or consuming a request slot. */
export async function invitationEmailBudgetAvailable(
  db: Db,
  invitation: InvitationEmailBudgetRequest,
  deps: InvitationMailLimits & { secret: string },
  /** The summary passes the same database time used for invitation expiry. */
  at?: Date,
): Promise<boolean> {
  const now =
    at ?? (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db)).rows[0]?.now
  if (!now) throw new Error('Invitation mail eligibility needs the database clock')
  const hour = new Date(now.getTime() - 3_600_000)
  const day = new Date(now.getTime() - 86_400_000)
  const { userId, organizationId, email } = invitation
  const scim = userId === null
  const hash = invitationRecipientHash(email, deps.secret)
  const counts = await db
    .selectFrom('invitation_email_requests')
    .select((eb) => {
      const sameTeam = eb('organization_id', '=', organizationId)
      const human = eb('user_id', 'is not', null)
      const sameRecipient = eb('recipient_hash', '=', hash)
      const inviter = eb.fn.countAll<string>().filterWhere('user_id', '=', userId)
      const team = eb.fn
        .countAll<string>()
        .filterWhere(sameTeam)
        .filterWhere(scim ? eb('user_id', 'is', null) : human)
      const globalRecipient = eb.fn.countAll<string>().filterWhere(sameRecipient)
      // Both sources count their own team's requests. App admissions also count human
      // requests from other teams.
      const recipient = globalRecipient.filterWhere(scim ? sameTeam : eb.or([human, sameTeam]))
      return [
        inviter.as('inviterDay'),
        inviter.filterWhere('requested_at', '>', hour).as('inviterHour'),
        team.as('teamDay'),
        team.filterWhere('requested_at', '>', hour).as('teamHour'),
        recipient.as('recipientDay'),
        recipient.filterWhere('requested_at', '>', hour).as('recipientHour'),
        globalRecipient.as('globalRecipientDay'),
        globalRecipient.filterWhere('requested_at', '>', hour).as('globalRecipientHour'),
      ]
    })
    .where('requested_at', '>', day)
    .where((eb) =>
      eb.or([
        ...(userId === null ? [] : [eb('user_id', '=', userId)]),
        eb('organization_id', '=', organizationId),
        eb('recipient_hash', '=', hash),
      ]),
    )
    .executeTakeFirstOrThrow()
  const recipientMaxPerHour = deps.mailRecipientMaxPerHour ?? 5
  const recipientMaxPerDay = deps.mailRecipientMaxPerDay ?? 20
  // Keep an abuse ceiling across sources and tenants while leaving room for the
  // same person to be provisioned into multiple organizations.
  const globalRecipientMultiplier = 4
  if (
    Number(counts.recipientHour) >= recipientMaxPerHour ||
    Number(counts.recipientDay) >= recipientMaxPerDay ||
    Number(counts.globalRecipientHour) >= globalRecipientMultiplier * recipientMaxPerHour ||
    Number(counts.globalRecipientDay) >= globalRecipientMultiplier * recipientMaxPerDay
  )
    return false
  if (scim)
    return (
      Number(counts.teamHour) < (deps.scimInvitationMaxPerHour ?? 60) &&
      Number(counts.teamDay) < (deps.scimInvitationMaxPerDay ?? 240)
    )
  if (
    Number(counts.inviterHour) >= (deps.invitationInviterMaxPerHour ?? 20) ||
    Number(counts.inviterDay) >= (deps.invitationInviterMaxPerDay ?? 100) ||
    Number(counts.teamHour) >= (deps.invitationTeamMaxPerHour ?? 50) ||
    Number(counts.teamDay) >= (deps.invitationTeamMaxPerDay ?? 200)
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
  invitation: InvitationEmailBudgetRequest,
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
