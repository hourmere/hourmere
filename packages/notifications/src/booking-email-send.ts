import type { Db } from '@hourmere/db'
import { brandEmail, type Mailer, type MailMessage } from '@hourmere/mail'

/** Protect the address before taking membership locks or writing a receipt. */
export function lockVerifiedHostAddress(db: Db, identity: { id: string; email: string }) {
  return db
    .selectFrom('auth.user')
    .select('id')
    .where('id', '=', identity.id)
    .where('email', '=', identity.email)
    .where('emailVerified', '=', true)
    .forShare()
    .executeTakeFirst()
}

export function lockBookingHostMembership(db: Db, bookingId: string, hostId: string) {
  return db
    .selectFrom('auth.member as m')
    .innerJoin('bookings as b', 'b.organization_id', 'm.organizationId')
    .select('m.id')
    .where('b.id', '=', bookingId)
    .where('m.userId', '=', hostId)
    .forShare('m')
    .executeTakeFirst()
}

/** Caller holds the shared budget lock and owns the recipient receipt in this transaction. */
export async function sendAndRecordBookingEmail(
  db: Db,
  mailer: Mailer,
  organizationId: string,
  recipientHash: Buffer | null,
  message: () => MailMessage,
  clock: () => Date,
  signal?: AbortSignal,
): Promise<Date> {
  const { getEmailBranding } = await import('@hourmere/scheduling')
  await mailer.send(brandEmail(message(), await getEmailBranding(db, organizationId)), { signal })
  const sentAt = clock()
  await db
    .insertInto('notification_email_sends')
    .values({ recipient_hash: recipientHash, sent_at: sentAt })
    .execute()
  return sentAt
}
