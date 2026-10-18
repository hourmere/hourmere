import { parseArgs } from 'node:util'
import {
  bookingCalendarJob,
  bookingCalendarRecoveryJob,
  redispatchBookingCalendar,
} from '@hourmere/calendars'
import { createDb, createPool } from '@hourmere/db'
import { createJobs } from '@hourmere/jobs'
import { z } from 'zod'

const { values } = parseArgs({
  options: {
    'connection-id': { type: 'string' },
    'booking-id': { type: 'string' },
  },
})
const id = z.uuid().safeParse(values['connection-id'] ?? values['booking-id'])
if (
  !id.success ||
  Boolean(values['connection-id']) === Boolean(values['booking-id']) ||
  !process.env.DATABASE_URL
) {
  console.error(
    'Set DATABASE_URL and pass either --connection-id <UUID> or --booking-id <chain root UUID>.',
  )
  process.exitCode = 1
} else {
  const db = createDb(createPool(process.env.DATABASE_URL))
  // Enqueue only. The normal worker uses its configured provider clients for the finite pass.
  const jobs = createJobs({
    connectionString: process.env.DATABASE_URL,
    definitions: [
      bookingCalendarJob({ db }),
      bookingCalendarRecoveryJob(
        { db },
        async () => {},
        async () => {},
      ),
    ],
    work: false,
    migrate: false,
  })
  try {
    await jobs.start()
    if (values['booking-id']) await redispatchBookingCalendar(db, jobs, id.data)
    else
      await jobs.enqueue(
        'booking-calendar-recover',
        { connectionId: id.data },
        { singletonKey: id.data },
      )
    console.log('Calendar writeback recovery queued.')
  } catch {
    console.error('Calendar writeback recovery could not be queued.')
    process.exitCode = 1
  } finally {
    await jobs.stop()
    await db.destroy()
  }
}
