import { randomBytes, randomUUID } from 'node:crypto'
import { createAuth, createAuthPool, type SignupPolicy } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { createFixtures } from '@hourmere/scheduling/testing'
import ICAL from 'ical.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendBookingNotification } from './index.ts'
import { deliverSignInEmail, queuedSignInEmail, type SignInEmailDeps } from './sign-in.ts'

vi.mock('@hourmere/core/locales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hourmere/core/locales')>()
  return {
    ...actual,
    localeRegistry: {
      ...actual.localeRegistry,
      qaa: {
        code: 'qaa',
        nativeName: 'Fixture',
        fallbacks: ['en'],
        formatLocale: 'fr-FR',
        direction: 'ltr',
      },
    },
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: (...args: unknown[]) => {
      const files = Reflect.apply(actual.readdirSync, actual, args)
      return String(args[0]).endsWith('/mail/src/catalogues/') ? [...files, 'qaa.json'] : files
    },
    readFileSync: (...args: unknown[]) => {
      if (String(args[0]).endsWith('/mail/src/catalogues/qaa.json'))
        return actual.readFileSync(
          new URL('../../mail/src/fixtures/locale-qaa.json', import.meta.url),
          'utf8',
        )
      return Reflect.apply(actual.readFileSync, actual, args)
    },
  }
})

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'http://localhost:4187'
const secret = randomBytes(32).toString('base64')
const signup: SignupPolicy = { mode: 'closed', allowedDomains: [] }
const now = Temporal.Instant.from('2026-10-19T12:00:00Z')

describe.skipIf(!serverUrl)('registered locale notification delivery', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  const sent: MailMessage[] = []
  const mailer = {
    senderEmail: 'calendar@example.org',
    send: async (message: MailMessage) => {
      sent.push(message)
    },
  }
  const signInDeps = (): SignInEmailDeps => ({ db, mailer, publicUrl, secret, signup })
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
  })
  beforeEach(async () => {
    await db.deleteFrom('sign_in_emails').execute()
    await db.deleteFrom('notification_email_sends').execute()
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
    sent.length = 0
  })
  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  it.each([false, true])(
    'honors the test locale through auth delivery (queued=%s)',
    async (queued) => {
      await db
        .insertInto('auth.user')
        .values({ name: 'Ada', email: 'ada@example.com', emailVerified: true })
        .execute()
      const auth = createAuth({
        pool: authPool,
        db,
        baseURL: publicUrl,
        secret,
        signup,
        mailer,
        ...(queued
          ? {
              queueSignInEmail: queuedSignInEmail(
                { enqueue: async () => randomUUID() },
                signInDeps(),
              ),
            }
          : {}),
      })
      await expect(
        auth.handler(
          new Request(`${publicUrl}/api/auth/sign-in/magic-link`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: publicUrl,
              'accept-language': 'qaa,en;q=0.5',
            },
            body: JSON.stringify({ email: 'ada@example.com', callbackURL: '/app' }),
          }),
        ),
      ).resolves.toMatchObject({ status: 200 })
      if (queued) {
        expect(sent).toHaveLength(0)
        const row = await db.selectFrom('sign_in_emails').select('id').executeTakeFirstOrThrow()
        await deliverSignInEmail(signInDeps(), row.id)
        expect(await db.selectFrom('sign_in_emails').select('id').execute()).toEqual([])
      } else await vi.waitFor(() => expect(sent).toHaveLength(1))
      expect(sent).toHaveLength(1)
      expect(sent[0]?.subject).toBe('Fixture connexion')
      expect(sent[0]?.html).toContain('<html lang="qaa">')
      expect(sent[0]?.text).toContain('works once')
    },
  )

  it('localizes the generated host name when no verified host survives cancellation', async () => {
    const fixtures = createFixtures(db)
    const host = await fixtures.host({ name: 'Grace' })
    const id = await fixtures.booking(
      host.organizationId,
      [host.userId],
      '2026-11-01T05:30:00Z',
      '2026-11-01T05:45:00Z',
      {
        status: 'cancelled',
        attendee: { name: 'Ada', email: 'ada@example.com' },
      },
    )
    await db
      .updateTable('booking_attendees')
      .set({ locale: 'qaa' })
      .where('booking_id', '=', id)
      .execute()
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', host.userId)
      .execute()
    await sendBookingNotification(
      { db, mailer, publicUrl, secret, now: () => now },
      id,
      'cancelled',
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('Your meeting with Fixture hôte has been cancelled.')
    expect(sent[0]?.text).toContain('Fixture hôte: Fixture hôte')
    expect(sent[0]?.html).toContain('<html lang="qaa">')
  })

  it('keeps a new locale across booking, reschedule and cancellation with localized ICS and DST', async () => {
    const fixtures = createFixtures(db)
    const host = await fixtures.host({ name: 'Grace', timeZone: 'America/New_York' })
    await db
      .updateTable('profiles')
      .set({ locale: 'qaa' })
      .where('user_id', '=', host.userId)
      .execute()
    const create = async (start: string, end: string) => {
      const id = await fixtures.booking(host.organizationId, [host.userId], start, end, {
        attendee: { name: 'Ada', email: 'ada@example.com' },
      })
      await db
        .updateTable('booking_attendees')
        .set({ locale: 'qaa', time_zone: 'America/New_York' })
        .where('booking_id', '=', id)
        .execute()
      return id
    }
    const first = await create('2026-11-01T05:30:00Z', '2026-11-01T05:45:00Z')
    const deps = { db, mailer, publicUrl, secret, now: () => now }
    await sendBookingNotification(deps, first, 'confirmed')
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: now.toString() })
      .where('id', '=', first)
      .execute()
    const next = await create('2026-11-01T06:30:00Z', '2026-11-01T06:45:00Z')
    await db
      .updateTable('bookings')
      .set({ rescheduled_from_id: first })
      .where('id', '=', next)
      .execute()
    await sendBookingNotification(deps, next, 'rescheduled')
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: now.toString() })
      .where('id', '=', next)
      .execute()
    await sendBookingNotification(deps, next, 'cancelled')
    expect(sent).toHaveLength(6)
    for (const [stage, messages] of [sent.slice(0, 2), sent.slice(2, 4), sent.slice(4)].entries()) {
      for (const message of messages) {
        expect(message.html).toContain('<html lang="qaa">')
        expect(message.text).toContain('Fixture activité: Fixture booking')
        expect(message.text).toContain('dimanche 1 novembre 2026')
        expect(message.text).toContain(stage === 0 ? 'GMT-04:00' : 'GMT-05:00')
        if (stage === 1) expect(message.text).toContain('GMT-04:00')
        const content = message.attachments?.[0]?.content
        expect(content).toBeDefined()
        const calendar = new ICAL.Component(ICAL.parse(content as string))
        const event = calendar.getFirstSubcomponent('vevent')
        expect(event?.getFirstPropertyValue('summary')).toMatch(
          /^Fixture Fixture booking avec (Grace|Ada)$/,
        )
        expect(event?.getFirstPropertyValue('description')).toContain('Fixture réservé avec Grace.')
        expect(event?.getFirstPropertyValue('uid')).toBe(`${first}@hourmere`)
        expect(event?.getFirstPropertyValue('sequence')).toBe(stage)
        expect(calendar.getFirstPropertyValue('method')).toBe(stage === 2 ? 'CANCEL' : 'REQUEST')
        expect(content).toContain(
          stage === 0 ? 'DTSTART:20261101T053000Z' : 'DTSTART:20261101T063000Z',
        )
        expect(content).not.toContain('token=')
      }
    }
  })
})
