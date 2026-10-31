import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InvitationEmailRequest } from './invitation-email.ts'
import { deliverInvitationEmail, type InvitationEmailSenderDeps } from './invitation-sender.ts'

const serverUrl = process.env.DATABASE_URL
type Deliver = typeof deliverInvitationEmail

async function senderCopy(replacement?: readonly [string, string]) {
  const location = new URL('./invitation-sender.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation matches its intended protection').toBe(true)
    source = source.replace(...replacement)
  }
  const javascript = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return (await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
  )) as typeof import('./invitation-sender.ts')
}

describe.skipIf(!serverUrl)('original invitation membership at durable send boundaries', () => {
  let owned: TestDatabase
  let db: Db
  let inviterId: string
  let authorizerId: string
  let teamId: string
  const send = vi.fn<InvitationEmailSenderDeps['mailer']['send']>()
  const deps = (overrides: Partial<InvitationEmailSenderDeps> = {}): InvitationEmailSenderDeps => ({
    db,
    mailer: { send },
    smtpConfigured: true,
    publicUrl: 'https://invitation.example.test',
    secret: 'synthetic-original-inviter-sender-secret',
    log() {},
    ...overrides,
  })

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'inviter_sender' })
    db = createDb(owned.pool)
  })

  beforeEach(async () => {
    await db.deleteFrom('notification_email_sends').execute()
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
    send.mockReset().mockResolvedValue(undefined)
    const users = await db
      .insertInto('auth.user')
      .values([
        { name: 'Original inviter', email: 'original@example.test', emailVerified: true },
        { name: 'Current owner', email: 'current@example.test', emailVerified: true },
      ])
      .returning('id')
      .execute()
    inviterId = users[0]?.id as string
    authorizerId = users[1]?.id as string
    teamId = (
      await db
        .insertInto('auth.organization')
        .values({ name: 'Sender team', slug: randomUUID(), createdAt: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    await db
      .insertInto('auth.member')
      .values([
        { userId: inviterId, organizationId: teamId, role: 'admin', createdAt: new Date() },
        { userId: authorizerId, organizationId: teamId, role: 'owner', createdAt: new Date() },
      ])
      .execute()
  })

  afterAll(async () => {
    try {
      expect(owned?.pool.totalCount ?? 0).toBeLessThanOrEqual(8)
    } finally {
      await owned?.drop()
    }
  })

  async function invitation(attempts = 0): Promise<InvitationEmailRequest> {
    const invitationId = randomUUID()
    await db
      .insertInto('auth.invitation')
      .values({
        id: invitationId,
        organizationId: teamId,
        inviterId,
        email: 'recipient@example.test',
        role: 'member',
        status: 'pending',
        createdAt: sql`clock_timestamp() - INTERVAL '5 minutes'`,
        expiresAt: sql`clock_timestamp() + INTERVAL '1 day'`,
      })
      .execute()
    await db
      .insertInto('invitation_deliveries')
      .values({
        invitation_id: invitationId,
        authorized_by_user_id: authorizerId,
        generation: 2,
        state: 'queued',
        attempts,
        last_error_code: attempts ? 'transport_error' : null,
      })
      .execute()
    return { invitationId, generation: 2 }
  }

  const removeOriginalInviter = () =>
    db
      .deleteFrom('auth.member')
      .where('userId', '=', inviterId)
      .where('organizationId', '=', teamId)
      .execute()
  const delivery = (payload: InvitationEmailRequest) =>
    db
      .selectFrom('invitation_deliveries')
      .selectAll()
      .where('invitation_id', '=', payload.invitationId)
      .executeTakeFirstOrThrow()

  async function expectSkipped(payload: InvitationEmailRequest, attempts: number) {
    expect(
      send,
      'a current authorizer cannot send a departed inviter’s link',
    ).not.toHaveBeenCalled()
    expect(await delivery(payload)).toMatchObject({
      state: 'skipped',
      attempts,
      last_error_code: 'invitation_ineligible',
      lease_id: null,
      lease_until: null,
    })
    expect(
      await db
        .selectFrom('auth.invitation')
        .select(['status', 'inviterId'])
        .where('id', '=', payload.invitationId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'pending', inviterId })
  }

  it.each([0, 2])(
    'skips queued delivery with %i previous attempts after original membership ends',
    async (attempts) => {
      const payload = await invitation(attempts)
      await removeOriginalInviter()
      await deliverInvitationEmail(deps(), payload)
      await expectSkipped(payload, attempts)
      expect(await db.selectFrom('notification_email_sends').selectAll().execute()).toHaveLength(0)
      await deliverInvitationEmail(deps(), payload)
      await expectSkipped(payload, attempts)
    },
  )

  it('does not count the original inviter’s membership in another team', async () => {
    const payload = await invitation()
    await removeOriginalInviter()
    const otherTeam = await db
      .insertInto('auth.organization')
      .values({ name: 'Other team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({
        userId: inviterId,
        organizationId: otherTeam.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    await deliverInvitationEmail(deps(), payload)
    await expectSkipped(payload, 0)
  })

  it.each([0, 2])(
    'keeps delivery with %i previous attempts eligible after the original inviter is demoted',
    async (attempts) => {
      const payload = await invitation(attempts)
      await db
        .updateTable('auth.member')
        .set({ role: 'member' })
        .where('userId', '=', inviterId)
        .where('organizationId', '=', teamId)
        .execute()
      await deliverInvitationEmail(deps(), payload)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.[0].text).toContain('Current owner')
      expect(await delivery(payload)).toMatchObject({
        state: 'smtp_accepted',
        attempts: attempts + 1,
      })
    },
  )

  async function verifyInitial(deliver: Deliver) {
    const payload = await invitation(2)
    await removeOriginalInviter()
    await deliver(deps({ smtpConfigured: false }), payload)
    await expectSkipped(payload, 2)
  }

  /** Revoke only after the real claim COMMIT, before the pre-SMTP transaction starts. */
  function afterClaim(hook: () => Promise<unknown>): Db {
    let commits = 0
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'transaction') return Reflect.get(target, property, receiver)
        return () => {
          const builder = target.transaction()
          return new Proxy(builder, {
            get(transaction, key, transactionReceiver) {
              if (key !== 'execute') return Reflect.get(transaction, key, transactionReceiver)
              return async (callback: Parameters<typeof builder.execute>[0]) => {
                const result = await transaction.execute(callback)
                if (++commits === 1) await hook()
                return result
              }
            },
          })
        }
      },
    })
  }

  async function verifyPreSmtp(deliver: Deliver) {
    const payload = await invitation(2)
    await deliver(deps({ db: afterClaim(removeOriginalInviter) }), payload)
    await expectSkipped(payload, 3)
  }

  async function verifyBudgetWait(deliver: Deliver) {
    const payload = await invitation(2)
    const holder = await owned.pool.connect()
    let sending: Promise<void> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(1852798057, 1835100524)')
      sending = deliver(deps(), payload)
      await expect
        .poll(
          async () =>
            Number(
              (
                await owned.pool.query<{ count: string }>(
                  "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'",
                )
              ).rows[0]?.count,
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(1)
      await removeOriginalInviter()
      await holder.query('COMMIT')
      await sending
      await expectSkipped(payload, 2)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await sending
    }
  }

  const protections = [
    {
      name: 'initial eligibility before configuration checks',
      mutation: [
        '    if (!(await originalInviterIsMember(trx, invitation))) {',
        '    if (false) {',
      ] as const,
      verify: verifyInitial,
    },
    {
      name: 'authority after waiting for the shared mail budget',
      mutation: [
        '  if (!(await originalInviterIsMember(db, invitation))) return false',
        '',
      ] as const,
      verify: verifyBudgetWait,
    },
    {
      name: 'authority immediately before SMTP',
      mutation: [
        '  if (!(await originalInviterIsMember(db, invitation))) return false',
        '',
      ] as const,
      verify: verifyPreSmtp,
    },
  ]

  it.each(protections)(
    'passes $name assertions with the unchanged source copy',
    async ({ verify }) => {
      await verify((await senderCopy()).deliverInvitationEmail)
    },
  )

  it.each(protections)(
    'detects removing $name through a real assertion failure',
    async ({ verify, mutation }) => {
      await expect(
        verify((await senderCopy(mutation)).deliverInvitationEmail),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
})
