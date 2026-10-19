import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const db = { destroy: vi.fn() }
  const jobs = { start: vi.fn(), stop: vi.fn(), enqueue: vi.fn() }
  return { db, jobs, redispatch: vi.fn(), values: {} as Record<string, string> }
})

vi.mock('node:util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:util')>()),
  parseArgs: () => ({ values: mocks.values }),
}))
vi.mock('@hourmere/db', () => ({
  createDb: () => mocks.db,
  createPool: vi.fn(),
}))
vi.mock('@hourmere/jobs', () => ({ createJobs: () => mocks.jobs }))
vi.mock('@hourmere/calendars', () => ({
  bookingCalendarJob: vi.fn(),
  bookingCalendarRecoveryJob: vi.fn(),
  redispatchBookingCalendar: mocks.redispatch,
}))

const id = '3ac5363e-dd77-4e6d-8fe4-21ec37ea785d'

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('DATABASE_URL', 'postgres://unused/unused')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('calendar writeback redispatch output', () => {
  it.each(['connection-id', 'booking-id'])('reports a new %s job as queued', async (option) => {
    mocks.values = { [option]: id }
    mocks.jobs.enqueue.mockResolvedValue('new-job')
    mocks.redispatch.mockResolvedValue('new-job')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await import('./redispatch-calendar-writeback.ts')

    expect(log).toHaveBeenCalledExactlyOnceWith('Calendar writeback recovery queued.')
    if (option === 'connection-id') {
      expect(mocks.jobs.enqueue).toHaveBeenCalledWith(
        'booking-calendar-recover',
        { connectionId: id },
        { singletonKey: id },
      )
      expect(mocks.redispatch).not.toHaveBeenCalled()
    } else {
      expect(mocks.redispatch).toHaveBeenCalledWith(mocks.db, mocks.jobs, id)
      expect(mocks.jobs.enqueue).not.toHaveBeenCalled()
    }
    expect(mocks.jobs.stop).toHaveBeenCalledOnce()
    expect(mocks.db.destroy).toHaveBeenCalledOnce()
  })

  it.each(['connection-id', 'booking-id'])(
    'reports a deduplicated %s job as already queued',
    async (option) => {
      mocks.values = { [option]: id }
      mocks.jobs.enqueue.mockResolvedValue(null)
      mocks.redispatch.mockResolvedValue(null)
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})

      await import('./redispatch-calendar-writeback.ts')

      expect(log).toHaveBeenCalledExactlyOnceWith('Calendar writeback recovery already queued.')
      expect(mocks.jobs.stop).toHaveBeenCalledOnce()
      expect(mocks.db.destroy).toHaveBeenCalledOnce()
    },
  )
})
