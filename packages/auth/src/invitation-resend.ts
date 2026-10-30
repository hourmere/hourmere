import type { Db } from '@hourmere/db'
import { sql } from 'kysely'

export interface ResendInvitation {
  role: string | null
  status: string
  expiresAt: Date
  createdAt: Date
}

export interface ResendInvitationDelivery {
  generation: number
  state: string
  lease_until: Date | null
  generation_started_at: Date
  updated_at: Date
}

export type InvitationEligibilityDenial = 'TEAM_MANAGEMENT_ACCESS_DENIED' | 'INVITATION_INELIGIBLE'

export type InvitationResendDenial =
  | InvitationEligibilityDenial
  | 'INVITATION_RECIPIENT_ALREADY_MEMBER'
  | 'INVITATION_GENERATION_LIMIT'
  | 'INVITATION_DELIVERY_BUSY'
  | 'INVITATION_RESEND_COOLDOWN'

/** Only member invitations that remain pending on the database clock can be resent. */
export function invitationEligibilityDenial(
  invitation: ResendInvitation,
  now: Date,
): InvitationEligibilityDenial | null {
  if (invitation.role !== 'member') return 'TEAM_MANAGEMENT_ACCESS_DENIED'
  if (invitation.status !== 'pending' || invitation.expiresAt <= now) return 'INVITATION_INELIGIBLE'
  return null
}

/** The read summary and explicit resend share these current-generation admission rules. */
export function invitationResendDenial(
  invitation: ResendInvitation,
  delivery: ResendInvitationDelivery | undefined,
  now: Date,
  recipientIsMember = false,
): InvitationResendDenial | null {
  const ineligible = invitationEligibilityDenial(invitation, now)
  if (ineligible) return ineligible
  if (recipientIsMember) return 'INVITATION_RECIPIENT_ALREADY_MEMBER'
  return invitationResendDeliveryDenial(invitation, delivery, now)
}

/** Shared by the authorized write path and the read-only eligibility wrapper. */
export function invitationResendDeliveryDenial(
  invitation: Pick<ResendInvitation, 'createdAt'>,
  delivery: ResendInvitationDelivery | undefined,
  now: Date,
):
  | 'INVITATION_GENERATION_LIMIT'
  | 'INVITATION_DELIVERY_BUSY'
  | 'INVITATION_RESEND_COOLDOWN'
  | null {
  const generation = delivery?.generation ?? 1
  if (generation >= 32) return 'INVITATION_GENERATION_LIMIT'
  if (delivery?.state === 'sending' && delivery.lease_until && delivery.lease_until > now)
    return 'INVITATION_DELIVERY_BUSY'
  // Every worker attempt updates updated_at, restarting the cooldown within a generation.
  const started = new Date(
    Math.max(
      (delivery?.generation_started_at ?? invitation.createdAt).getTime(),
      (delivery?.updated_at ?? invitation.createdAt).getTime(),
    ),
  )
  if (now.getTime() - started.getTime() < 60_000) return 'INVITATION_RESEND_COOLDOWN'
  return null
}

/** Same-team membership only; this must not expose global recipient account existence. */
export async function invitationRecipientIsMember(db: Db, organizationId: string, email: string) {
  const member = await db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .select('m.id')
    .where('m.organizationId', '=', organizationId)
    .where(sql<string>`lower(btrim(u.email))`, '=', email.trim().toLowerCase())
    .executeTakeFirst()
  return Boolean(member)
}
