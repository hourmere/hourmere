import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { z } from 'zod'
import { lockUser, requireCalendarSession } from './index.ts'

/** Owner-session selection preserves existing pinned booking targets. */
export async function configureCalDavWriteCalendar(
  deps: { db: Db; now?: () => number },
  principal: Principal,
  calendarId: string | null,
) {
  const session = requireCalendarSession(principal)
  if (calendarId !== null && !z.uuid().safeParse(calendarId).success)
    throw new DomainError('invalid', 'invalid_calendar_settings')
  await deps.db.transaction().execute(async (trx) => {
    await lockUser(trx, session, deps.now ?? Date.now)
    if (calendarId !== null) {
      const calendar = await trx
        .selectFrom('calendars as c')
        .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
        .select(['c.access_role', 'c.sync_state', 'cc.status'])
        .where('c.id', '=', calendarId)
        .where('cc.user_id', '=', session.user.id)
        .where('cc.provider', '=', 'caldav')
        .forKeyShare('c')
        .executeTakeFirst()
      if (!calendar) throw new DomainError('not_found', 'calendar_not_found')
      const metadata = z
        .object({ caldavDiscovery: z.object({ available: z.literal(true) }) })
        .safeParse(calendar.sync_state)
      if (calendar.status !== 'active' || calendar.access_role !== 'writer' || !metadata.success)
        throw new DomainError('conflict', 'caldav_calendar_unavailable')
    }
    const result = await trx
      .updateTable('profiles')
      .set({ destination_calendar_id: calendarId })
      .where('user_id', '=', session.user.id)
      .executeTakeFirst()
    if (!result.numUpdatedRows) throw new DomainError('not_found', 'profile_not_found')
  })
}
