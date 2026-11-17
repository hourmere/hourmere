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

/** Factory only: CalDAV remains absent from production worker registration. */
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
