import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type InvitationMailLimits,
  reserveInvitationEmailBudget,
} from './invitation-mail-limits.ts'
import {
  invitationRecipientHash,
  lockNotificationEmailBudget,
  notificationEmailBudget,
  notificationRecipientHash,
  purgeNotificationEmailSends,
  signInEmailBudget,
  signInRecipientHash,
} from './mail-limits.ts'

const serverUrl = process.env.DATABASE_URL
const SECRET = 'synthetic-invitation-budget-secret'
const NOW = new Date('2026-11-01T12:00:00Z')
const actor = { userId: randomUUID(), organizationId: randomUUID(), email: 'ada@example.test' }

describe.skipIf(!serverUrl)('invitation admission budgets (real PostgreSQL)', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_budget' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
    await owned?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('invitation_email_requests').execute()
    await db.deleteFrom('notification_email_sends').execute()
  })
  const reserve = (limits: InvitationMailLimits = {}, identity = actor, at = NOW) =>
    db
      .transaction()
      .execute((trx) =>
        reserveInvitationEmailBudget(trx, identity, { secret: SECRET, ...limits }, at),
      )
  const counts = async () => ({
    requests: (await db.selectFrom('invitation_email_requests').selectAll().execute()).length,
    mail: (await db.selectFrom('notification_email_sends').selectAll().execute()).length,
  })
  async function history(count: number, identity = actor, at = NOW) {
    await db
      .insertInto('invitation_email_requests')
      .values(
        Array.from({ length: count }, () => ({
          user_id: identity.userId,
          organization_id: identity.organizationId,
          requested_at: at,
        })),
      )
      .execute()
  }
  async function mailHistory(count: number, hash: Buffer | null, at = NOW) {
    await db
      .insertInto('notification_email_sends')
      .values(Array.from({ length: count }, () => ({ recipient_hash: hash, sent_at: at })))
      .execute()
  }

  it('requires a transaction and atomically reserves one durable request plus one mail slot', async () => {
    await expect(reserveInvitationEmailBudget(db, actor, { secret: SECRET }, NOW)).rejects.toThrow(
      'needs a transaction',
    )
    expect(await counts()).toEqual({ requests: 0, mail: 0 })
    await expect(
      db.transaction().execute(async (trx) => {
        expect(await reserveInvitationEmailBudget(trx, actor, { secret: SECRET }, NOW)).toBe(true)
        throw new Error('synthetic enqueue failure')
      }),
    ).rejects.toThrow('synthetic enqueue failure')
    expect(await counts()).toEqual({ requests: 0, mail: 0 })
    expect(await reserve()).toBe(true)
    expect(await db.selectFrom('invitation_email_requests').selectAll().execute()).toEqual([
      { user_id: actor.userId, organization_id: actor.organizationId, requested_at: NOW },
    ])
    expect(await db.selectFrom('notification_email_sends').selectAll().execute()).toEqual([
      { recipient_hash: invitationRecipientHash(actor.email, SECRET), sent_at: NOW },
    ])
  })

  it.each([
    ['inviter hourly', 20, false, true],
    ['inviter daily', 100, true, true],
    ['team hourly', 50, false, false],
    ['team daily', 200, true, false],
  ] as const)(
    'enforces default %s capacity across recipients and teams',
    async (_, cap, daily, inviter) => {
      await history(
        cap - 1,
        {
          ...actor,
          userId: inviter ? actor.userId : randomUUID(),
          organizationId: inviter ? randomUUID() : actor.organizationId,
        },
        daily ? new Date(NOW.getTime() - 2 * 3_600_000) : NOW,
      )
      expect(await reserve()).toBe(true)
      const before = await counts()
      expect(await reserve()).toBe(false)
      expect(await counts()).toEqual(before)
    },
  )

  it.each([
    ['inviter hourly', { invitationInviterMaxPerHour: 1 }],
    ['inviter daily', { invitationInviterMaxPerDay: 1 }],
    ['team hourly', { invitationTeamMaxPerHour: 1 }],
    ['team daily', { invitationTeamMaxPerDay: 1 }],
  ] as const)(
    'honors configured %s limits without writing rejected requests',
    async (_, limits) => {
      expect(await reserve(limits)).toBe(true)
      expect(await reserve(limits)).toBe(false)
      expect(await counts()).toEqual({ requests: 1, mail: 1 })
    },
  )

  it('enforces normalized invitation recipient hourly capacity across unrelated inviters and teams', async () => {
    await mailHistory(4, invitationRecipientHash('  ADA@Example.TEST ', SECRET))
    expect(await reserve()).toBe(true)
    expect(
      await reserve({}, { ...actor, userId: randomUUID(), organizationId: randomUUID() }),
    ).toBe(false)
    expect(await counts()).toEqual({ requests: 1, mail: 5 })
  })

  it('enforces invitation daily capacity independently of the hourly window', async () => {
    await mailHistory(
      19,
      invitationRecipientHash(actor.email, SECRET),
      new Date(NOW.getTime() - 7_200_000),
    )
    expect(await reserve()).toBe(true)
    expect(await reserve()).toBe(false)
    expect(await counts()).toEqual({ requests: 1, mail: 20 })
  })

  it('shares the global mail fence and preserves reserved capacity for hosts and sign-in', async () => {
    await mailHistory(99, null)
    expect(await reserve()).toBe(true)
    expect(await reserve({}, { ...actor, email: 'other@example.test' })).toBe(false)
    expect(await counts()).toEqual({ requests: 1, mail: 100 })
    await db.transaction().execute(async (trx) => {
      await lockNotificationEmailBudget(trx)
      expect(
        await notificationEmailBudget(
          trx,
          {},
          notificationRecipientHash(actor.email, SECRET),
          false,
          NOW,
        ),
      ).toBeUndefined()
      expect(
        await signInEmailBudget(trx, {}, signInRecipientHash(actor.email, SECRET), NOW),
      ).toBeUndefined()
    })
    await mailHistory(20, null)
    await db.transaction().execute(async (trx) => {
      await lockNotificationEmailBudget(trx)
      expect(
        await notificationEmailBudget(
          trx,
          {},
          notificationRecipientHash(actor.email, SECRET),
          false,
          NOW,
        ),
      ).toBe('instance_hourly_limit')
      expect(await signInEmailBudget(trx, {}, signInRecipientHash(actor.email, SECRET), NOW)).toBe(
        'instance_hourly_limit',
      )
    })
  })

  it('keeps invitation, sign-in and booking recipient budgets independent', async () => {
    await mailHistory(5, notificationRecipientHash(actor.email, SECRET))
    await mailHistory(5, signInRecipientHash(actor.email, SECRET))
    expect(await reserve()).toBe(true)
    await mailHistory(4, invitationRecipientHash(actor.email, SECRET))
    expect(await reserve()).toBe(false)
    expect(invitationRecipientHash(' ADA@EXAMPLE.TEST ', SECRET)).toEqual(
      invitationRecipientHash(actor.email, SECRET),
    )
    expect(invitationRecipientHash(actor.email, 'other-synthetic-secret')).not.toEqual(
      invitationRecipientHash(actor.email, SECRET),
    )
  })

  it('excludes exact hourly and daily boundaries from all rolling counts', async () => {
    await history(200, actor, new Date(NOW.getTime() - 86_400_000))
    await history(20, actor, new Date(NOW.getTime() - 3_600_000))
    await mailHistory(
      20,
      invitationRecipientHash(actor.email, SECRET),
      new Date(NOW.getTime() - 86_400_000),
    )
    await mailHistory(
      5,
      invitationRecipientHash(actor.email, SECRET),
      new Date(NOW.getTime() - 3_600_000),
    )
    expect(await reserve()).toBe(true)
  })

  it('serializes concurrent admission at the final inviter, team, recipient and global slots', async () => {
    for (const limits of [
      { invitationInviterMaxPerHour: 1 },
      { invitationTeamMaxPerHour: 1 },
      { mailRecipientMaxPerHour: 1 },
      { mailMaxPerHour: 1 },
    ]) {
      await db.deleteFrom('invitation_email_requests').execute()
      await db.deleteFrom('notification_email_sends').execute()
      const results = await Promise.all([reserve(limits), reserve(limits)])
      expect(results.sort()).toEqual([false, true])
      expect(await counts()).toEqual({ requests: 1, mail: 1 })
    }
  })

  it('holds the shared mail lock and reads production time only after obtaining it', async () => {
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const blocker = db.transaction().execute(async (trx) => {
      await lockNotificationEmailBudget(trx)
      held.resolve()
      await release.promise
    })
    await held.promise
    let completed = false
    const pending = db
      .transaction()
      .execute((trx) => reserveInvitationEmailBudget(trx, actor, { secret: SECRET }))
      .finally(() => {
        completed = true
      })
    let afterWait = new Date(0)
    try {
      let waiting = false
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await owned.pool.query<{ waiting: boolean; now: Date }>(`SELECT
          EXISTS (SELECT FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event='advisory') AS waiting, clock_timestamp() AS now`)
        afterWait = result.rows[0]?.now ?? new Date(0)
        waiting = result.rows[0]?.waiting ?? false
        if (waiting || completed) break
        await setTimeout(5)
      }
      expect(waiting).toBe(true)
      expect(completed).toBe(false)
    } finally {
      release.resolve()
      await blocker
      await pending
    }
    const reservation = await db
      .selectFrom('invitation_email_requests')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(reservation.requested_at.getTime()).toBeGreaterThanOrEqual(afterWait.getTime())
  })

  it('purges invitation request accounting only when older than two days', async () => {
    await history(1, actor, new Date(NOW.getTime() - 2 * 86_400_000 - 1))
    await history(1, actor, new Date(NOW.getTime() - 2 * 86_400_000))
    await history(1)
    await purgeNotificationEmailSends(db, NOW)
    expect(await counts()).toEqual({ requests: 2, mail: 0 })
  })
})
