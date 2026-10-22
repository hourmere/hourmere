import { randomBytes } from 'node:crypto'
import { createTestDatabase } from '@hourmere/db/testing'
import { bookingNotificationJob, signInEmailJobs } from '@hourmere/notifications'
import { describe, expect, it, vi } from 'vitest'
import { type RunningServer, startServer } from './server.ts'

vi.mock('@hourmere/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hourmere/notifications')>()
  return {
    ...actual,
    bookingNotificationJob: vi.fn(actual.bookingNotificationJob),
    signInEmailJobs: vi.fn(actual.signInEmailJobs),
  }
})

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('booking notification mailer in the real composition', () => {
  it('preserves the sender, hash secret and mail limits for booking and sign-in jobs', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    const secret = randomBytes(32).toString('base64')
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    let running: RunningServer | undefined
    try {
      running = await startServer({
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: secret,
        HOURMERE_ROLE: 'web',
        SIGNUP: 'closed',
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
        // Web mode queues jobs without sending, so no SMTP connection is opened.
        SMTP_URL: 'smtp://127.0.0.1:1',
        MAIL_FROM: 'Hourmere bookings <bookings@example.com>',
        MAIL_RECIPIENT_MAX_PER_HOUR: '3',
        MAIL_RECIPIENT_MAX_PER_DAY: '12',
        MAIL_MAX_PER_HOUR: '40',
        SIGN_IN_MAIL_MAX_PER_HOUR: '2',
        SIGN_IN_MAIL_MAX_PER_DAY: '9',
      })
      expect(bookingNotificationJob).toHaveBeenCalledOnce()
      const mailer = vi.mocked(bookingNotificationJob).mock.calls[0]?.[0].mailer
      // A send-only wrapper loses this property and silently restores the legacy
      // host organizer, even though the underlying SMTP sender is still configured.
      expect(mailer?.senderEmail).toBe('bookings@example.com')
      expect(vi.mocked(bookingNotificationJob).mock.calls[0]?.[0]).toMatchObject({
        secret,
        mailRecipientMaxPerHour: 3,
        mailRecipientMaxPerDay: 12,
        mailMaxPerHour: 40,
      })
      expect(signInEmailJobs).toHaveBeenCalledOnce()
      expect(vi.mocked(signInEmailJobs).mock.calls[0]?.[0]).toMatchObject({
        secret,
        signInMailMaxPerHour: 2,
        signInMailMaxPerDay: 9,
        mailMaxPerHour: 40,
      })
    } finally {
      await running?.close()
      await owned.drop()
      for (const spy of spies) spy.mockRestore()
    }
  }, 20_000)
})
