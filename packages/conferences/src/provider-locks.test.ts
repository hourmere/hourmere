import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicBooking } from '../../scheduling/src/bookings.ts'
import { createFixtures } from '../../scheduling/src/testing.ts'
import {
  beginZoomConnection,
  type ConferenceDeps,
  finishZoomConnection,
  refreshConference,
} from './index.ts'
import { conferenceTestSession, fakeZoom, TEST_CONFERENCE_KEY } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const now = Date.parse('2026-11-01T12:00Z')

describe.skipIf(!databaseUrl)('Zoom provider I/O and public booking lock compatibility', () => {
  let database: TestDatabase, db: Db
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
  })
  afterAll(async () => {
    await database?.drop()
  })

  for (const operation of ['OAuth', 'refresh'] as const)
    for (const stage of ['token exchange', 'identity lookup'] as const)
      it(`commits a same-host public booking during a 3 s ${operation} ${stage}`, async () => {
        const owner = await conferenceTestSession(db),
          provider = fakeZoom(),
          fixtures = createFixtures(db),
          handle = `zoom-lock-${randomUUID().slice(0, 8)}`
        provider.controls.identity.id = `synthetic-${randomUUID()}`
        await db
          .updateTable('auth.session')
          .set({ expiresAt: new Date('2028-01-01T00:00Z') })
          .where('id', '=', owner.sessionId)
          .execute()
        await db
          .insertInto('profiles')
          .values({ user_id: owner.user.id, handle, time_zone: 'UTC' })
          .execute()
        await fixtures.schedule(owner.user.id, { timeZone: 'UTC' })
        await fixtures.eventType(owner.organization.id, owner.user.id, { slug: 'call' })
        const deps: ConferenceDeps = {
          db,
          zoom: { client: provider.client, encryptionKey: TEST_CONFERENCE_KEY },
          now: () => now,
        }
        const authorization = new URL((await beginZoomConnection(deps, owner)).authorizationUrl),
          query = new URLSearchParams({
            state: authorization.searchParams.get('state') as string,
            code: 'synthetic-code',
          })
        let connectionId = ''
        if (operation === 'refresh') {
          expect(await finishZoomConnection(deps, owner, query)).toBe('connected')
          connectionId = (
            await db
              .selectFrom('conference_connections')
              .select('id')
              .where('user_id', '=', owner.user.id)
              .executeTakeFirstOrThrow()
          ).id
        }

        let entered: () => void = () => {},
          providerPending = false
        const providerEntered = new Promise<void>((resolve) => {
          entered = resolve
        })
        const delay = async (body: Record<string, unknown>) => {
          providerPending = true
          entered()
          await setTimeout(3000)
          providerPending = false
          return Response.json(body)
        }
        if (stage === 'token exchange')
          provider.controls.tokenHook = async () => delay(provider.controls.token)
        else provider.controls.identityHook = async () => delay(provider.controls.identity)

        const providerOperation =
          operation === 'OAuth'
            ? finishZoomConnection(deps, owner, query)
            : refreshConference(deps, owner, connectionId)
        let bookingElapsed = 0,
          completedWhileProviderPending = false,
          hostCount = 0
        try {
          await Promise.race([
            providerEntered,
            providerOperation.then(() => {
              throw new Error('Zoom operation finished before reaching the delayed provider')
            }),
          ])
          const started = performance.now()
          const result = await createPublicBooking(
            { db, now: () => Temporal.Instant.fromEpochMilliseconds(now) },
            {
              handle,
              slug: 'call',
              start: Temporal.Instant.from('2026-11-02T09:00Z'),
              invitee: { name: 'Synthetic', email: 'synthetic@example.com', timeZone: 'UTC' },
            },
          )
          bookingElapsed = performance.now() - started
          completedWhileProviderPending = providerPending
          hostCount = (
            await db
              .selectFrom('booking_hosts')
              .select('user_id')
              .where('booking_id', '=', result.booking.id)
              .where('user_id', '=', owner.user.id)
              .execute()
          ).length
        } finally {
          const outcome = await providerOperation
          if (operation === 'OAuth') expect(outcome).toBe('connected')
        }
        console.info(
          `${operation} ${stage}: same-host public booking ${Math.round(bookingElapsed)} ms; provider pending at commit: ${completedWhileProviderPending}`,
        )
        expect(hostCount).toBe(1)
        expect(completedWhileProviderPending).toBe(true)
        expect(bookingElapsed).toBeLessThan(1500)
      })
})
