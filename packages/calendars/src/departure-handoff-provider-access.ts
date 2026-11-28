import type { Db } from '@hourmere/db'
import { scimSuspended } from '@hourmere/db/scim-suspension'

/** A committed replacement still needs its host's current authority in that team. */
export async function canWriteHandoffReplacement(db: Db, rootBookingId: string, userId: string) {
  const handoff = await db
    .selectFrom('departure_booking_handoffs as h')
    .select((eb) =>
      eb
        .exists(
          eb
            .selectFrom('auth.member as m')
            .innerJoin('auth.user as u', 'u.id', 'm.userId')
            .select('u.id')
            .whereRef('m.organizationId', '=', 'h.organization_id')
            .where('u.id', '=', userId)
            .where('u.emailVerified', '=', true)
            .where((eb) =>
              eb.not(scimSuspended(eb.ref('m.organizationId'), eb.ref('m.userId'), true)),
            ),
        )
        .as('hostAvailable'),
    )
    .where('h.replacement_booking_id', '=', rootBookingId)
    .executeTakeFirst()
  return handoff?.hostAvailable ?? true
}
