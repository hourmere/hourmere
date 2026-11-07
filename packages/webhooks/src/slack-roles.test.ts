import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { ServiceContext } from '@hourmere/scheduling'
import {
  createTestTeam,
  createTestUser,
  type TestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decryptWebhookSecret } from './crypto.ts'
import {
  createSlackDestination,
  deleteSlackDestination,
  listSlackDestinations,
  testSlackDestination,
  updateSlackDestination,
} from './slack.ts'

const url = 'https://hooks.slack.com/services/TROLE/BROLE/role-fixture-secret'
const attacker = 'https://hooks.slack.com/services/TATTACK/BATTACK/attacker-fixture-secret'
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 6).toString('base64') }
const now = Temporal.Instant.from('2026-11-01T12:00Z')
type Principal = ServiceContext['principal']
type Kind = 'api_key' | 'oauth'

/** The same verified user as an API key or an MCP OAuth grant. */
function as(principal: Principal, kind: Kind): Principal {
  const { user, organization } = principal
  if (kind === 'oauth')
    return {
      kind,
      user,
      organization,
      oauthConsentId: randomUUID(),
      clientId: 'slack-role-client',
      scopes: ['mcp:tools'],
    }
  return principal
}

// Lock-wait probes run several hold/release cycles; CI load must not hit the 5 s default.
describe.skipIf(!process.env.DATABASE_URL)(
  'Slack destination owner/admin checks',
  { timeout: 60_000 },
  () => {
    let owned: TestDatabase
    let db: Db
    beforeAll(async () => {
      owned = await createTestDatabase(process.env.DATABASE_URL as string)
      db = createDb(owned.pool)
    })
    afterAll(async () => {
      await owned?.drop()
    })

    async function fixture() {
      const owner = await createTestUser(db)
      const member = await createTestUser(db)
      const team = await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: member, role: 'member' },
      ])
      const enqueue = vi.fn(async () => randomUUID())
      const queue = { enqueue }
      const admin = testContext(db, team.as(owner), () => now)
      const destination = await createSlackDestination(admin, settings, {
        url,
        events: ['booking.created'],
      })
      // A finished sample is outbox history that refused calls must leave untouched.
      await testSlackDestination(admin, settings, destination.id, queue)
      await db
        .updateTable('webhook_deliveries')
        .set({ status: 'delivered' })
        .where('webhook_id', '=', destination.id)
        .execute()
      enqueue.mockClear()
      return { owner, member, team, destination, queue, enqueue }
    }

    /** Every stored byte of the destination (encrypted URL, settings, pause) and its outbox. */
    async function snapshot(id: string) {
      return JSON.stringify({
        destination: await db
          .selectFrom('webhooks')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst(),
        outbox: await db
          .selectFrom('webhook_deliveries')
          .selectAll()
          .where('webhook_id', '=', id)
          .orderBy('id')
          .execute(),
      })
    }

    async function storedUrl(id: string) {
      const row = await db
        .selectFrom('webhooks')
        .select(['url_ciphertext', 'organization_id'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      return decryptWebhookSecret(
        row.url_ciphertext ?? Buffer.alloc(0),
        settings.encryptionKey,
        `${id}:url`,
        row.organization_id,
      )
    }

    function operations(
      principal: Principal,
      id: string,
      queue: { enqueue: () => Promise<string> },
    ) {
      const ctx = testContext(db, principal, () => now)
      return {
        update: () =>
          updateSlackDestination(
            ctx,
            id,
            { url: attacker, events: ['booking.cancelled'], isActive: false, eventTypeId: null },
            settings,
          ),
        delete: () => deleteSlackDestination(ctx, id),
        test: () => testSlackDestination(ctx, settings, id, queue),
      }
    }

    async function setRole(teamId: string, user: TestUser, role: string) {
      await db
        .updateTable('auth.member')
        .set({ role })
        .where('organizationId', '=', teamId)
        .where('userId', '=', user.id)
        .execute()
    }

    /** Holds `sql` (a row lock) in its own transaction and reports who queues behind it. */
    async function hold(sql: string, id: string) {
      const client = await owned.pool.connect()
      let pid: number
      try {
        await client.query('BEGIN')
        await client.query(sql, [id])
        pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid as number
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
        throw error
      }
      const queued = async () =>
        (
          await owned.pool.query(
            'SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))',
            [pid],
          )
        ).rows.length > 0
      return { client, queued }
    }
    const destinationLock = 'SELECT id FROM webhooks WHERE id = $1 FOR UPDATE'
    // Generous bounds within the suite timeout; a regression fails assertions, not the bound.
    const probe = { timeout: 15_000, interval: 10 }
    const organizationLock = 'SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE'

    /**
     * Polls the lock holder until the call settles. A call that queues behind the held lock can
     * never settle while it is held, so it is always observed; no timing assumption is needed.
     */
    async function settleWithoutQueueing(
      call: () => Promise<unknown>,
      queued: () => Promise<boolean>,
    ) {
      let settled = false
      const outcome = call().then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      )
      void outcome.finally(() => {
        settled = true
      })
      while (!settled) if (await queued()) return { queuedBehindLock: true, outcome }
      return { queuedBehindLock: false, outcome }
    }

    // Browser sessions run the team context check first; apps/server/src/slack-roles.test.ts
    // covers them through REST.
    it.each(['api_key', 'oauth'] as const)(
      'refuses an ordinary member (%s) on update, delete and test without changing the row or outbox',
      async (kind) => {
        const { member, team, destination, queue, enqueue } = await fixture()
        const before = await snapshot(destination.id)
        for (const [name, run] of Object.entries(
          operations(as(team.as(member), kind), destination.id, queue),
        )) {
          await expect(run(), name).rejects.toMatchObject({ code: 'insufficient_role' })
          expect(await snapshot(destination.id), name).toBe(before)
        }
        expect(enqueue).not.toHaveBeenCalled()
        expect(await storedUrl(destination.id)).toBe(url)
        await expect(
          listSlackDestinations(testContext(db, as(team.as(member), kind))),
        ).rejects.toMatchObject({ code: 'insufficient_role' })
      },
    )

    it('refuses a member before it takes or waits for the destination or organization lock', async () => {
      const { member, team, destination, queue, enqueue } = await fixture()
      const before = await snapshot(destination.id)
      const principal = team.as(member)
      const calls: [string, string, string, () => Promise<unknown>][] = [
        ...Object.entries(operations(principal, destination.id, queue)).map(
          ([name, run]) =>
            [name, destinationLock, destination.id, run] as [
              string,
              string,
              string,
              () => Promise<unknown>,
            ],
        ),
        [
          'create',
          organizationLock,
          team.id,
          () =>
            createSlackDestination(testContext(db, principal), settings, {
              url: attacker,
              events: ['booking.created'],
            }),
        ],
      ]
      for (const [name, lock, id, run] of calls) {
        const { client, queued } = await hold(lock, id)
        let outcome: Promise<{ error: unknown }> | undefined
        try {
          const result = await settleWithoutQueueing(run, queued)
          outcome = result.outcome
          expect(result.queuedBehindLock, name).toBe(false)
          expect((await outcome).error, name).toMatchObject({ code: 'insufficient_role' })
        } finally {
          await client.query('ROLLBACK')
          client.release()
          await outcome
        }
      }
      expect(await snapshot(destination.id)).toBe(before)
      expect(enqueue).not.toHaveBeenCalled()
    })

    it.each(['api_key', 'oauth'] as const)(
      'refuses a %s owner demoted while waiting for the destination lock',
      async (kind) => {
        const { owner, team, destination, queue, enqueue } = await fixture()
        const before = await snapshot(destination.id)
        for (const name of ['update', 'delete', 'test'] as const) {
          const { client, queued } = await hold(destinationLock, destination.id)
          let call: Promise<unknown> | undefined
          try {
            call = operations(as(team.as(owner), kind), destination.id, queue)
              [name]()
              .catch((error: unknown) => error)
            await vi.waitFor(async () => expect(await queued()).toBe(true), probe)
            // The demotion commits in the same transaction that releases the lock.
            await client.query(
              `UPDATE auth.member SET role = 'member' WHERE "organizationId" = $1 AND "userId" = $2`,
              [team.id, owner.id],
            )
            await client.query('COMMIT')
            expect(await call, name).toMatchObject({ code: 'insufficient_role' })
          } finally {
            await client.query('ROLLBACK')
            client.release()
            await call
          }
          expect(await snapshot(destination.id), name).toBe(before)
          await setRole(team.id, owner, 'owner')
        }
        expect(enqueue).not.toHaveBeenCalled()
        expect(await storedUrl(destination.id)).toBe(url)
      },
    )

    it('refuses an API-key owner demoted while waiting to create a destination', async () => {
      const owner = await createTestUser(db)
      const team = await createTestTeam(db, [{ user: owner, role: 'owner' }])
      const { client, queued } = await hold(organizationLock, team.id)
      let call: Promise<unknown> | undefined
      try {
        call = createSlackDestination(testContext(db, team.as(owner)), settings, {
          url: attacker,
          events: ['booking.created'],
        }).catch((error: unknown) => error)
        await vi.waitFor(async () => expect(await queued()).toBe(true), probe)
        await client.query(
          `UPDATE auth.member SET role = 'member' WHERE "organizationId" = $1 AND "userId" = $2`,
          [team.id, owner.id],
        )
        await client.query('COMMIT')
        expect(await call).toMatchObject({ code: 'insufficient_role' })
      } finally {
        await client.query('ROLLBACK')
        client.release()
        await call
      }
      expect(
        await db
          .selectFrom('webhooks')
          .select('id')
          .where('organization_id', '=', team.id)
          .execute(),
      ).toEqual([])
    })

    it('counts a test attempt only after the final owner/admin check found the destination', async () => {
      const { owner, member, team, destination, queue } = await fixture()
      const admit = vi.fn()
      for (const principal of [team.as(member), as(team.as(member), 'oauth')])
        await expect(
          testSlackDestination(testContext(db, principal), settings, destination.id, queue, admit),
        ).rejects.toMatchObject({ code: 'insufficient_role' })
      await expect(
        testSlackDestination(testContext(db, team.as(owner)), settings, randomUUID(), queue, admit),
      ).rejects.toMatchObject({ code: 'slack_destination_not_found' })
      expect(admit).not.toHaveBeenCalled()
      const refusal = new Error('budget spent')
      await expect(
        testSlackDestination(
          testContext(db, team.as(owner)),
          settings,
          destination.id,
          queue,
          () => {
            throw refusal
          },
        ),
      ).rejects.toBe(refusal)
      expect(queue.enqueue).not.toHaveBeenCalled()
      await testSlackDestination(
        testContext(db, team.as(owner)),
        settings,
        destination.id,
        queue,
        admit,
      )
      expect(admit).toHaveBeenCalledTimes(1)
      expect(queue.enqueue).toHaveBeenCalledTimes(1)
    })
  },
)
