import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { invitationResendDenial } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { manageInvitation } from '../../auth/src/invitations.ts'
import { cleanupInvitationDeliveries } from './invitation-deliveries.ts'
import { deliverInvitationEmail } from './invitation-sender.ts'

const serverUrl = process.env.DATABASE_URL

async function sourceCopy(location: URL, before: string, after: string) {
  const source = readFileSync(location, 'utf8')
  expect(source.includes(before), 'mutation finds the intended protection').toBe(true)
  const javascript = stripTypeScriptTypes(source.replace(before, after)).replace(
    /from '([^']+)'/g,
    (_, specifier: string) => {
      let resolved: string
      if (specifier.startsWith('.')) resolved = new URL(specifier, location).href
      else {
        try {
          resolved = import.meta.resolve(specifier)
        } catch {
          resolved = pathToFileURL(createRequire(location).resolve(specifier)).href
        }
      }
      return `from '${resolved}'`
    },
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

describe.skipIf(!serverUrl)('invitation generation recovery with PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let organizationId: string
  let original: Awaited<ReturnType<typeof actor>>
  let replacement: Awaited<ReturnType<typeof actor>>
  const sent: MailMessage[] = []
  const now = () => new Date()

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_recovery' })
    db = createDb(owned.pool)
  })
  beforeEach(async () => {
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
    sent.length = 0
    organizationId = (
      await db
        .insertInto('auth.organization')
        .values({ name: 'Recovery team', slug: randomUUID(), createdAt: now() })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    original = await actor('Original administrator', 'owner')
    replacement = await actor('Current administrator', 'admin')
  })
  afterAll(async () => {
    try {
      expect(owned?.pool.totalCount ?? 0).toBeLessThanOrEqual(4)
    } finally {
      await owned?.drop()
    }
  })

  async function actor(name: string, role: string) {
    const userId = (
      await db
        .insertInto('auth.user')
        .values({ name, email: `${randomUUID()}@example.test`, emailVerified: true })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    await db
      .insertInto('auth.member')
      .values({ userId, organizationId, role, createdAt: now() })
      .execute()
    const sessionId = (
      await db
        .insertInto('auth.session')
        .values({
          userId,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: now(),
          activeOrganizationId: organizationId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    return { userId, sessionId, activeOrganizationId: organizationId }
  }

  const invitation = () =>
    manageInvitation(db, original, { organizationId, email: `${randomUUID()}@example.test` })
  async function age(id: string) {
    await db
      .updateTable('invitation_deliveries')
      .set({
        generation_started_at: sql`clock_timestamp() - INTERVAL '5 minutes'`,
        updated_at: sql`clock_timestamp() - INTERVAL '5 minutes'`,
      })
      .where('invitation_id', '=', id)
      .execute()
  }
  const delivery = (id: string) =>
    db
      .selectFrom('invitation_deliveries')
      .selectAll()
      .where('invitation_id', '=', id)
      .executeTakeFirstOrThrow()
  const resend = (
    row: Awaited<ReturnType<typeof invitation>>,
    manage = manageInvitation,
    requestId = randomUUID(),
  ) =>
    manage(db, replacement, {
      organizationId,
      invitationId: row.id,
      email: row.email,
      resend: true,
      expectedGeneration: row.delivery.generation,
      requestId,
    })
  const send = (row: Awaited<ReturnType<typeof invitation>>, deliver = deliverInvitationEmail) =>
    deliver(
      {
        db,
        publicUrl: 'https://recovery.example.test',
        secret: 'synthetic-recovery-secret',
        smtpConfigured: true,
        mailer: { send: async (message) => void sent.push(message) },
        log: () => {},
      },
      { invitationId: row.id, generation: row.delivery.generation },
    )

  async function verifyActor(
    manage = manageInvitation,
    deliver = deliverInvitationEmail,
    departed = false,
  ) {
    const row = await invitation()
    await age(row.id)
    if (departed)
      await db
        .deleteFrom('auth.member')
        .where('organizationId', '=', organizationId)
        .where('userId', '=', original.userId)
        .execute()
    else
      await db
        .updateTable('auth.member')
        .set({ role: 'member' })
        .where('organizationId', '=', organizationId)
        .where('userId', '=', original.userId)
        .execute()
    expect(invitationResendDenial(row, await delivery(row.id), now())).toBeNull()
    const renewed = await resend(row, manage)
    sent.length = 0
    await send(renewed, deliver)
    expect(
      await delivery(row.id),
      'the acting administrator authorizes this generation',
    ).toMatchObject({
      authorized_by_user_id: replacement.userId,
      generation: 2,
      state: 'smtp_accepted',
    })
    expect(sent, 'an authorized resend actually reaches the fake mailer').toHaveLength(1)
    expect(sent[0]?.text).toContain('Current administrator')
    expect(sent[0]?.text).not.toContain('Original administrator')
    expect(renewed.inviterId, 'sign-up trust remains anchored to the original inviter').toBe(
      original.userId,
    )
  }

  it.each([false, true])(
    'delivers another admin resend when the original inviter departed=%s',
    async (departed) => {
      await verifyActor(manageInvitation, deliverInvitationEmail, departed)
    },
  )

  it.each(['demoted', 'deleted'] as const)(
    'refuses a generation after its authorizing actor is %s',
    async (state) => {
      const row = await invitation()
      await age(row.id)
      const renewed = await resend(row)
      if (state === 'deleted')
        await db.deleteFrom('auth.user').where('id', '=', replacement.userId).execute()
      else
        await db
          .updateTable('auth.member')
          .set({ role: 'member' })
          .where('userId', '=', replacement.userId)
          .where('organizationId', '=', organizationId)
          .execute()
      await send(renewed)
      expect(sent).toHaveLength(0)
      expect(await delivery(row.id)).toMatchObject({
        authorized_by_user_id: replacement.userId,
        state: 'skipped',
        last_error_code: 'invitation_ineligible',
      })
    },
  )

  it('renews an expired pending invitation in place and keeps stale generations unable to send', async () => {
    const row = await invitation()
    await db
      .updateTable('auth.invitation')
      .set({ expiresAt: sql`clock_timestamp() - INTERVAL '1 day'` })
      .where('id', '=', row.id)
      .execute()
    const expired = await db
      .selectFrom('auth.invitation')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow()
    await age(row.id)
    expect(invitationResendDenial(expired, await delivery(row.id), now())).toBeNull()
    await send(row)
    expect(sent).toHaveLength(0)
    expect(await delivery(row.id)).toMatchObject({ state: 'skipped' })
    await age(row.id)
    const requestId = randomUUID()
    const renewed = await resend(row, manageInvitation, requestId)
    expect(renewed).toMatchObject({ id: row.id, delivery: { generation: 2, state: 'queued' } })
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000)
    expect(await resend(row, manageInvitation, requestId)).toEqual(renewed)
    expect(await db.selectFrom('auth.invitation').select('id').execute()).toEqual([{ id: row.id }])
    await send(row)
    expect(sent).toHaveLength(0)
    await send(renewed)
    expect(sent).toHaveLength(1)
  })

  it('serializes concurrent expired renewals after an organization lock wait without a duplicate row', async () => {
    const row = await invitation()
    await db
      .updateTable('auth.invitation')
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where('id', '=', row.id)
      .execute()
    await age(row.id)
    const blocker = await owned.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [organizationId])
    const pending = [resend(row), resend(row)].map(async (request) => {
      try {
        return { result: await request }
      } catch (error) {
        return { error }
      }
    })
    try {
      await expect
        .poll(
          async () =>
            Number(
              (
                await owned.pool.query<{ count: string }>(
                  `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE '%auth%organization%'`,
                )
              ).rows[0]?.count,
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(2)
    } finally {
      await blocker.query('COMMIT')
      blocker.release()
    }
    const outcomes = await Promise.all(pending)
    expect(outcomes.filter((outcome) => outcome.result)).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome.error)?.error).toMatchObject({
      body: { code: 'INVITATION_CONFLICT' },
    })
    expect(await delivery(row.id)).toMatchObject({ generation: 2, state: 'queued' })
    expect(await db.selectFrom('auth.invitation').select('id').execute()).toEqual([{ id: row.id }])
  })

  async function verifyRetention(generation: number, cleanup = cleanupInvitationDeliveries) {
    const row = await invitation()
    const validity = 72 * 3_600_000
    await db
      .updateTable('auth.invitation')
      .set({
        createdAt: sql`clock_timestamp() - INTERVAL '13 days'`,
        expiresAt: sql`clock_timestamp() - INTERVAL '10 days'`,
      })
      .where('id', '=', row.id)
      .execute()
    await db
      .updateTable('invitation_deliveries')
      .set({
        generation,
        expiry_duration_ms: validity,
        generation_started_at: sql`clock_timestamp() - INTERVAL '11 days'`,
        updated_at: sql`clock_timestamp() - INTERVAL '10 days'`,
      })
      .where('invitation_id', '=', row.id)
      .execute()
    const before = await delivery(row.id)
    await cleanup(db)
    const retained = await db
      .selectFrom('invitation_deliveries')
      .selectAll()
      .where('invitation_id', '=', row.id)
      .executeTakeFirst()
    // Match the server summary's legacy fallback if cleanup has lost the tombstone.
    const refreshed = {
      ...row,
      delivery: { ...row.delivery, generation: retained?.generation ?? 1 },
    }
    if (generation === 32) {
      await expect(resend(refreshed)).rejects.toMatchObject({
        body: { code: 'INVITATION_GENERATION_LIMIT' },
      })
      expect(invitationResendDenial(row, retained, now())).toBe('INVITATION_GENERATION_LIMIT')
    } else {
      const renewed = await resend(refreshed)
      expect(renewed.delivery.generation, 'cleanup must not reset the renewal generation').toBe(
        generation + 1,
      )
      expect(
        renewed.expiresAt.getTime() - Date.now(),
        'renewal must keep its original 72-hour validity',
      ).toBeGreaterThan(validity - 5_000)
      expect(Number((await delivery(row.id)).expiry_duration_ms)).toBe(validity)
    }
    expect(retained, 'pending delivery metadata survives cleanup intact after expiry').toEqual(
      before,
    )
  }

  it.each([32, 7])(
    'retains expired generation %s through cleanup so its cap and original validity survive renewal',
    async (generation) => {
      await verifyRetention(generation)
    },
  )

  it.each([32, 7])(
    'detects deleting an expired generation %s tombstone with a real renewal assertion',
    async (generation) => {
      const copy = await sourceCopy(
        new URL('./invitation-deliveries.ts', import.meta.url),
        "i.status IN ('accepted', 'canceled', 'rejected')",
        "(i.status IN ('accepted', 'canceled', 'rejected') OR (i.status = 'pending' AND i.\"expiresAt\" <= clock_timestamp()))",
      )
      await expect(
        verifyRetention(generation, copy.cleanupInvitationDeliveries),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  async function verifyDuplicate(manage = manageInvitation) {
    const row = await invitation()
    await db
      .updateTable('auth.invitation')
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where('id', '=', row.id)
      .execute()
    await age(row.id)
    const active = await manageInvitation(db, replacement, { organizationId, email: row.email })
    await expect(resend(row, manage)).rejects.toMatchObject({
      body: { code: 'INVITATION_CONFLICT' },
    })
    expect(await delivery(row.id)).toMatchObject({ generation: 1 })
    const activeRows = await db
      .selectFrom('auth.invitation')
      .select('id')
      .where('organizationId', '=', organizationId)
      .where('status', '=', 'pending')
      .where('expiresAt', '>', now())
      .execute()
    expect(activeRows).toEqual([{ id: active.id }])
  }

  it('refuses expired renewal when another active invitation already exists', async () => {
    await verifyDuplicate()
  })

  async function verifyPendingLimit(manage = manageInvitation) {
    const row = await invitation()
    await db
      .updateTable('auth.invitation')
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where('id', '=', row.id)
      .execute()
    await age(row.id)
    await db
      .insertInto('auth.invitation')
      .values(
        Array.from({ length: 100 }, () => ({
          inviterId: original.userId,
          organizationId,
          email: `${randomUUID()}@example.test`,
          role: 'member',
          status: 'pending',
          expiresAt: new Date(Date.now() + 3_600_000),
        })),
      )
      .execute()
    await expect(resend(row, manage)).rejects.toMatchObject({
      body: { code: 'INVITATION_PENDING_LIMIT' },
    })
    expect(await delivery(row.id)).toMatchObject({ generation: 1 })
  }

  it('applies the active pending limit when renewing an expired invitation', async () => {
    await verifyPendingLimit()
  })

  it.each([
    [
      'duplicate pending invitation',
      'if (otherPending) throw conflict()',
      'void otherPending',
      verifyDuplicate,
    ],
    [
      'active pending limit',
      'if (Number(pending.count) >= 100)',
      'if (Number(pending.count) > 100)',
      verifyPendingLimit,
    ],
  ] as const)(
    'detects removing the expired renewal %s protection',
    async (_name, before, after, verify) => {
      const copy = await sourceCopy(
        new URL('../../auth/src/invitations.ts', import.meta.url),
        before,
        after,
      )
      await expect(verify(copy.manageInvitation)).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  it('detects keeping the original inviter in a resend generation using the same delivery assertion', async () => {
    const copy = await sourceCopy(
      new URL('../../auth/src/invitations.ts', import.meta.url),
      'authorized_by_user_id: actor.userId,',
      'authorized_by_user_id: invitation.inviterId,',
    )
    await expect(verifyActor(copy.manageInvitation)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it.each([
    [
      'authority',
      'await checkTeamManagementMembership(db, authorizedByUserId, invitation.organizationId)',
      'await checkTeamManagementMembership(db, invitation.inviterId, invitation.organizationId)',
    ],
    [
      'mail attribution',
      ".where('u.id', '=', authorizedByUserId)",
      ".where('u.id', '=', invitation.inviterId)",
    ],
  ])('detects using the original inviter for generation %s', async (_name, before, after) => {
    const copy = await sourceCopy(new URL('./invitation-sender.ts', import.meta.url), before, after)
    await expect(verifyActor(manageInvitation, copy.deliverInvitationEmail)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
})
