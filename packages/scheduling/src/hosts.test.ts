import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicTeamBooking } from './bookings.ts'
import { activateRoundRobin, createEventType, updateEventType } from './event-types.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )

describe.skipIf(!serverUrl)('host eligibility transaction locks', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function blockedBy(waiter: number, blocker: number): Promise<boolean> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await owned.pool.query<{ blocked: boolean }>(
        'SELECT $2=ANY(pg_blocking_pids($1)) AS blocked',
        [waiter, blocker],
      )
      if (result.rows[0]?.blocked) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return false
  }

  for (const operation of [
    'individual booking',
    'collective booking',
    'create',
    'update',
    'activation',
  ] as const)
    for (const withdrawal of ['verification', 'membership'] as const)
      it(`holds host ${withdrawal} through ${operation} commit`, async () => {
        const owner = await createTestUser(db, 'Team owner')
        const host = await createTestUser(db, 'Assigned host')
        const team = await createTestTeam(db, [
          { user: owner, role: 'owner' },
          { user: host, role: 'member' },
        ])
        const ctx = testContext(db, team.as(owner), now)
        const f = createFixtures(db)
        await f.schedule(owner.id, { timeZone: 'UTC' })
        await f.schedule(host.id, { timeZone: 'UTC' })
        const hosts = [{ userId: owner.id }, { userId: host.id }]
        const event = await createEventType(ctx, {
          slug: 'locked',
          title: 'Host lock check',
          durationMinutes: 30,
          schedulingType: operation === 'activation' ? 'round_robin' : 'collective',
          hosts,
        })
        if (operation === 'individual booking')
          await updateEventType(ctx, event.id, {
            schedulingType: 'individual',
            hosts: [{ userId: host.id }],
          })

        // Pause the real service after assertHosts and before it commits. Foreign keys
        // alone take KEY SHARE, which cannot hold emailVerified or team membership.
        const table = operation.endsWith('booking')
          ? 'bookings'
          : operation === 'activation'
            ? 'round_robin_state'
            : 'event_types'
        const gate = randomUUID()
        const blocker = await owned.pool.connect()
        const revoker = await owned.pool.connect()
        await blocker.query('BEGIN')
        await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [gate])
        const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]?.pid as number
        const revokerPid = (await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]?.pid as number
        await owned.pool.query(`CREATE FUNCTION hold_host_write() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${gate}',0)); RETURN NEW; END $$`)
        await owned.pool.query(`CREATE TRIGGER hold_host_write BEFORE INSERT OR UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION hold_host_write()`)
        const pending = outcome<unknown>(
          operation.endsWith('booking')
            ? createPublicTeamBooking(
                { db, now },
                {
                  handle: ctx.principal.organization.slug,
                  slug: event.slug,
                  start: Temporal.Instant.from('2026-11-02T09:00Z'),
                  invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
                },
              )
            : operation === 'activation'
              ? activateRoundRobin(ctx, event.id)
              : operation === 'update'
                ? updateEventType(ctx, event.id, { hosts })
                : createEventType(ctx, {
                    slug: 'new-locked',
                    title: 'Saved assignment',
                    durationMinutes: 30,
                    schedulingType: 'collective',
                    hosts,
                  }),
        )
        let withdrawalResult: Promise<unknown> | undefined
        try {
          const waiters = await (async () => {
            for (let attempt = 0; attempt < 200; attempt++) {
              const result = await owned.pool.query<{ pid: number }>(
                'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
                [blockerPid],
              )
              if (result.rows[0]) return result.rows[0].pid
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
            throw new Error('Expected service to reach the transaction gate')
          })()
          withdrawalResult = outcome(
            withdrawal === 'verification'
              ? revoker.query('UPDATE auth."user" SET "emailVerified"=false WHERE id=$1', [host.id])
              : revoker.query('DELETE FROM auth.member WHERE "organizationId"=$1 AND "userId"=$2', [
                  team.id,
                  host.id,
                ]),
          )
          expect(await blockedBy(revokerPid, waiters)).toBe(true)
          await blocker.query('COMMIT')
          expect(await pending).toHaveProperty('value')
          expect(await withdrawalResult).toHaveProperty('value')
          if (withdrawal === 'verification') {
            const user = await db
              .selectFrom('auth.user')
              .select('emailVerified')
              .where('id', '=', host.id)
              .executeTakeFirstOrThrow()
            expect(user.emailVerified).toBe(false)
          } else {
            expect(
              await db
                .selectFrom('auth.member')
                .select('id')
                .where('organizationId', '=', team.id)
                .where('userId', '=', host.id)
                .execute(),
            ).toEqual([])
          }
        } finally {
          await blocker.query('ROLLBACK').catch(() => {})
          blocker.release()
          await pending
          await withdrawalResult
          revoker.release()
          await owned.pool.query(`DROP TRIGGER hold_host_write ON ${table}`)
          await owned.pool.query('DROP FUNCTION hold_host_write()')
        }
      })
})
