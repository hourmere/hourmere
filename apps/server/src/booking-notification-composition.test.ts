import { randomBytes } from 'node:crypto'
import { createTestDatabase } from '@hourmere/db/testing'
import { bookingNotificationJob } from '@hourmere/notifications'
import { describe, expect, it, vi } from 'vitest'
import { type RunningServer, startServer } from './server.ts'

vi.mock('@hourmere/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hourmere/notifications')>()
  return { ...actual, bookingNotificationJob: vi.fn(actual.bookingNotificationJob) }
})

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('booking notification mailer in the real composition', () => {
  it('preserves the configured sender mailbox for the booking job', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    let running: RunningServer | undefined
    try {
      running = await startServer({
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        HOURMERE_ROLE: 'web',
        SIGNUP: 'closed',
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
        // Web mode queues jobs without sending, so no SMTP connection is opened.
        SMTP_URL: 'smtp://127.0.0.1:1',
        MAIL_FROM: 'Hourmere bookings <bookings@example.com>',
      })
      expect(bookingNotificationJob).toHaveBeenCalledOnce()
      const mailer = vi.mocked(bookingNotificationJob).mock.calls[0]?.[0].mailer
      // A send-only wrapper loses this property and silently restores the legacy
      // host organizer, even though the underlying SMTP sender is still configured.
      expect(mailer?.senderEmail).toBe('bookings@example.com')
    } finally {
      await running?.close()
      await owned.drop()
      for (const spy of spies) spy.mockRestore()
    }
  }, 20_000)
})
