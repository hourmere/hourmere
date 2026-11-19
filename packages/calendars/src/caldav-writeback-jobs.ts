import type { Db } from '@hourmere/db'
import { defineJob, type Jobs } from '@hourmere/jobs'
import { z } from 'zod'
import { CalDavError } from './caldav-transport.ts'
import {
  CALDAV_BOOKING_JOB,
  type CalDavBookingPayload,
  type CalDavWritebackDeps,
  writeCalDavBooking,
} from './caldav-writeback.ts'

/** Reconcile conditional writes through the shared background job system. */
export function calDavBookingJob(deps: CalDavWritebackDeps) {
  return defineJob({
    name: CALDAV_BOOKING_JOB,
    payload: z.union([
      z.strictObject({ bookingId: z.uuid() }),
      z.strictObject({ groupSlotId: z.uuid() }),
    ]),
    policy: 'stately',
    concurrency: 2,
    retry: { limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 120 },
    expireInSeconds: 120,
    handler: async (payload, { signal }) => {
      try {
        await writeCalDavBooking(deps, payload, signal)
      } catch (error) {
        if (
          error instanceof CalDavError &&
          ['unauthorized', 'forbidden', 'conflict'].includes(error.code)
        )
          return
        throw error
      }
    },
  })
}
export function createCalDavBookingEnqueuer(
  jobs: Pick<Jobs<readonly [ReturnType<typeof calDavBookingJob>]>, 'enqueue'>,
) {
  return (payload: CalDavBookingPayload, transaction?: Db) =>
    jobs.enqueue(CALDAV_BOOKING_JOB, payload, {
      transaction,
      singletonKey: 'bookingId' in payload ? payload.bookingId : `group:${payload.groupSlotId}`,
    })
}

/** Reconcile pinned copies after credentials recover, including cancellations and group slots. */
export function calDavRecoveryJob(
  db: Db,
  enqueueWrite: (payload: CalDavBookingPayload, transaction: Db) => Promise<unknown>,
  continueRecovery: (
    payload: { connectionId: string; kind: 'booking' | 'group'; after?: string },
    transaction: Db,
  ) => Promise<unknown>,
) {
  return defineJob({
    name: 'caldav-booking-recover',
    payload: z.strictObject({
      connectionId: z.uuid(),
      kind: z.enum(['booking', 'group']).default('booking'),
      after: z.uuid().optional(),
    }),
    policy: 'stately',
    concurrency: 2,
    retry: { limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 120 },
    expireInSeconds: 120,
    handler: async ({ connectionId, kind, after }, { signal }) => {
      await db.transaction().execute(async (trx) => {
        const connection = await trx
          .selectFrom('calendar_connections')
          .select('id')
          .where('id', '=', connectionId)
          .where('provider', '=', 'caldav')
          .where('status', '=', 'active')
          .executeTakeFirst()
        if (!connection) return
        const rows =
          kind === 'booking'
            ? await trx
                .selectFrom('booking_calendar_targets as t')
                .innerJoin('calendars as c', 'c.id', 't.calendar_id')
                .select('t.root_booking_id as id')
                .distinct()
                .where('c.connection_id', '=', connectionId)
                .$if(Boolean(after), (q) => q.where('t.root_booking_id', '>', after as string))
                .orderBy('t.root_booking_id')
                .limit(100)
                .execute()
            : await trx
                .selectFrom('group_slots as s')
                .innerJoin('calendars as c', 'c.id', 's.destination_calendar_id')
                .select('s.id')
                .where('c.connection_id', '=', connectionId)
                .$if(Boolean(after), (q) => q.where('s.id', '>', after as string))
                .orderBy('s.id')
                .limit(100)
                .execute()
        for (const { id } of rows) {
          signal.throwIfAborted()
          await enqueueWrite(kind === 'booking' ? { bookingId: id } : { groupSlotId: id }, trx)
        }
        if (rows.length === 100)
          await continueRecovery({ connectionId, kind, after: rows.at(-1)?.id }, trx)
        else if (kind === 'booking') await continueRecovery({ connectionId, kind: 'group' }, trx)
      })
    },
  })
}
