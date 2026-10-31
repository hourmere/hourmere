import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { invitationEligibilityDenial, invitationResendDenial, maySignUp } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { manageInvitation } from '../../auth/src/invitations.ts'
import { reserveInvitationEmailBudget } from './invitation-mail-limits.ts'
import { deliverInvitationEmail } from './invitation-sender.ts'
import { lockNotificationEmailBudget } from './mail-limits.ts'

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
    await db.deleteFrom('invitation_email_requests').execute()
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

  it.each(['demoted', 'deleted', 'unverified'] as const)(
    'refuses a generation after its authorizing actor is %s',
    async (state) => {
      const row = await invitation()
      await age(row.id)
      const renewed = await resend(row)
      if (state === 'deleted')
        await db.deleteFrom('auth.user').where('id', '=', replacement.userId).execute()
      else if (state === 'unverified')
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', replacement.userId)
          .execute()
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

  it('delivers a verified generation after its authorizing browser session has ended', async () => {
    const row = await invitation()
    await age(row.id)
    const renewed = await resend(row)
    await db.deleteFrom('auth.session').where('userId', '=', replacement.userId).execute()
    await send(renewed)
    expect(sent).toHaveLength(1)
    expect(await delivery(row.id)).toMatchObject({
      authorized_by_user_id: replacement.userId,
      generation: 2,
      state: 'smtp_accepted',
      attempts: 1,
    })
  })

  async function verifyGenerationActorProof(
    phase: 'before claim' | 'after claim',
    deliver = deliverInvitationEmail,
  ) {
    const row = await invitation()
    await age(row.id)
    const renewed = await resend(row)
    const ledgerBefore = await db.selectFrom('notification_email_sends').select('sent_at').execute()
    const revoke = async () => {
      await db
        .updateTable('auth.user')
        .set({ emailVerified: false })
        .where('id', '=', replacement.userId)
        .execute()
    }
    let commits = 0
    const interleaved = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'transaction') return Reflect.get(target, property, receiver)
        return () => {
          const builder = target.transaction()
          return new Proxy(builder, {
            get(transaction, key, transactionReceiver) {
              if (key !== 'execute') return Reflect.get(transaction, key, transactionReceiver)
              return async (callback: Parameters<typeof builder.execute>[0]) => {
                const result = await transaction.execute(callback)
                if (++commits === 1 && phase === 'after claim') {
                  expect(await delivery(renewed.id)).toMatchObject({
                    state: 'sending',
                    attempts: 1,
                  })
                  await revoke()
                }
                return result
              }
            },
          })
        }
      },
    })
    if (phase === 'before claim') await revoke()
    await deliver(
      {
        db: interleaved,
        publicUrl: 'https://recovery.example.test',
        secret: 'synthetic-recovery-secret',
        smtpConfigured: true,
        mailer: { send: async (message) => void sent.push(message) },
        log: () => {},
      },
      { invitationId: renewed.id, generation: renewed.delivery.generation },
    )
    expect(sent, 'unverified generation authority must never start SMTP').toHaveLength(0)
    expect(await delivery(renewed.id)).toMatchObject({
      authorized_by_user_id: replacement.userId,
      generation: 2,
      state: 'skipped',
      attempts: phase === 'before claim' ? 0 : 1,
      last_error_code: 'invitation_ineligible',
      lease_id: null,
      lease_until: null,
    })
    expect(
      (await db.selectFrom('notification_email_sends').select('sent_at').execute()).length -
        ledgerBefore.length,
    ).toBe(phase === 'before claim' ? 0 : 1)
    expect(
      (
        await db
          .selectFrom('auth.user')
          .select('emailVerified')
          .where('id', '=', original.userId)
          .executeTakeFirstOrThrow()
      ).emailVerified,
      'the verified original inviter cannot replace current generation authority',
    ).toBe(true)
  }

  it.each(['before claim', 'after claim'] as const)(
    'rechecks the generation actor email proof %s using unchanged source copies',
    async (phase) => {
      const source = ".where('emailVerified', '=', true)"
      const copy = await sourceCopy(
        new URL('./invitation-sender.ts', import.meta.url),
        source,
        source,
      )
      await verifyGenerationActorProof(phase, copy.deliverInvitationEmail)
    },
  )

  it.each(['before claim', 'after claim'] as const)(
    'detects removed generation actor email proof %s in a source copy',
    async (phase) => {
      const copy = await sourceCopy(
        new URL('./invitation-sender.ts', import.meta.url),
        ".where('emailVerified', '=', true)",
        '',
      )
      await expect(
        verifyGenerationActorProof(phase, copy.deliverInvitationEmail),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  it('detects a removed preclaim authority check through real attempt and budget assertions', async () => {
    const copy = await sourceCopy(
      new URL('./invitation-sender.ts', import.meta.url),
      `const authorized = await invitationAuthorizationIsCurrent(
      trx,
      invitation,
      delivery.authorized_by_user_id ?? invitation.inviterId,
    )`,
      'const authorized = true',
    )
    await expect(
      verifyGenerationActorProof('before claim', copy.deliverInvitationEmail),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects a removed pre-SMTP authority check through a real mailer assertion', async () => {
    const copy = await sourceCopy(
      new URL('./invitation-sender.ts', import.meta.url),
      'if (!(await invitationAuthorizationIsCurrent(trx, invitation, authorizedByUserId))) {',
      'if (false) {',
    )
    await expect(
      verifyGenerationActorProof('after claim', copy.deliverInvitationEmail),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function expire(id: string) {
    await db
      .updateTable('auth.invitation')
      .set({ expiresAt: sql`clock_timestamp() - INTERVAL '1 day'` })
      .where('id', '=', id)
      .execute()
  }
  const storedInvitation = (id: string) =>
    db.selectFrom('auth.invitation').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

  async function verifyReplacement(manage = manageInvitation) {
    const row = await invitation()
    await expire(row.id)
    const fresh = await resend(row, manage)
    expect(fresh.id, 'an expired invitation requires a new ID').not.toBe(row.id)
    expect(fresh.inviterId, 'the new invitation trusts the acting administrator').toBe(
      replacement.userId,
    )
    expect(fresh).toMatchObject({
      existing: false,
      status: 'pending',
      delivery: { generation: 1, state: 'queued', attempts: 0 },
    })
    expect(fresh.expiresAt.getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000)
    const retired = await storedInvitation(row.id)
    expect(
      invitationEligibilityDenial(retired, now()),
      'the old invitation link remains unusable after replacement',
    ).toBe('INVITATION_INELIGIBLE')
    expect(retired.status, 'the old invitation is canceled atomically').toBe('canceled')
    expect(await delivery(row.id)).toMatchObject({
      generation: 1,
      state: 'skipped',
      last_error_code: 'invitation_ineligible',
      lease_id: null,
      lease_until: null,
    })
    expect(await delivery(fresh.id)).toMatchObject({
      generation: 1,
      authorized_by_user_id: replacement.userId,
      state: 'queued',
    })
    const rows = await db
      .selectFrom('auth.invitation')
      .select(['id', 'status'])
      .orderBy('status')
      .execute()
    expect(rows).toEqual([
      { id: row.id, status: 'canceled' },
      { id: fresh.id, status: 'pending' },
    ])
    await send(row)
    expect(sent, 'stale delivery jobs cannot revive the old invitation link').toHaveLength(0)
    await send(fresh)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('Current administrator')
    expect(sent[0]?.text).not.toContain('Original administrator')
    expect(sent[0]?.text).toContain(fresh.id)
    expect(sent[0]?.text).not.toContain(row.id)
    return { row, fresh }
  }

  it('atomically cancels an expired invitation and delivers a fresh link under its acting inviter', async () => {
    await verifyReplacement()
  })

  it.each(['closed', 'first-user'] as const)(
    'does not revive the earliest inviter signup trust when a non-allowlisted admin replaces an expired invitation (%s)',
    async (mode) => {
      await db
        .updateTable('auth.user')
        .set({ createdAt: new Date('2000-01-01T00:00:00Z') })
        .where('id', '=', original.userId)
        .execute()
      const row = await invitation()
      const policy = { mode, allowedDomains: ['trusted.test'] }
      expect(await maySignUp(db, policy, row.email)).toBe(true)
      await expire(row.id)
      expect(await maySignUp(db, policy, row.email)).toBe(false)
      const fresh = await resend(row)
      expect(fresh.inviterId).toBe(replacement.userId)
      expect(
        await maySignUp(db, policy, row.email),
        'an expired invitation cannot restore sign-up trust from its old inviter',
      ).toBe(false)
      await db
        .updateTable('auth.user')
        .set({ email: `${randomUUID()}@trusted.test` })
        .where('id', '=', replacement.userId)
        .execute()
      expect(await maySignUp(db, policy, row.email), 'sign-up trust follows the new inviter').toBe(
        true,
      )
    },
  )

  it('serializes concurrent expired replacements at the team lock and creates exactly one new invitation', async () => {
    const row = await invitation()
    await expire(row.id)
    const blocker = await owned.pool.connect()
    const pending: Promise<{ result?: Awaited<ReturnType<typeof invitation>>; error?: unknown }>[] =
      []
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [
        organizationId,
      ])
      for (let index = 0; index < 2; index++)
        pending.push(
          resend(row).then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          ),
        )
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
      body: { code: 'INVITATION_INELIGIBLE' },
    })
    const fresh = outcomes.find((outcome) => outcome.result)?.result
    expect(fresh?.id).not.toBe(row.id)
    expect(fresh?.inviterId).toBe(replacement.userId)
    expect(await delivery(row.id)).toMatchObject({ generation: 1, state: 'skipped' })
    expect(await storedInvitation(row.id)).toMatchObject({ status: 'canceled' })
    const active = await db
      .selectFrom('auth.invitation')
      .select('id')
      .where('organizationId', '=', organizationId)
      .where('status', '=', 'pending')
      .execute()
    expect(active).toEqual([{ id: fresh?.id }])
    expect(await db.selectFrom('auth.invitation').select('id').execute()).toHaveLength(2)
  })

  async function verifyExpiryDuringBudgetWait(manage = manageInvitation) {
    const row = await invitation()
    await age(row.id)
    const budgetHeld = Promise.withResolvers<void>()
    const releaseBudget = Promise.withResolvers<void>()
    let holderPid = 0
    const holder = db.transaction().execute(async (trx) => {
      await lockNotificationEmailBudget(trx)
      holderPid = Number(
        (await trx.selectNoFrom(sql<number>`pg_backend_pid()`.as('pid')).executeTakeFirstOrThrow())
          .pid,
      )
      budgetHeld.resolve()
      await releaseBudget.promise
    })
    await budgetHeld.promise
    let pending: ReturnType<typeof manageInvitation> | undefined
    try {
      await db
        .updateTable('auth.invitation')
        .set({ expiresAt: sql`clock_timestamp() + INTERVAL '1 second'` })
        .where('id', '=', row.id)
        .execute()
      pending = manage(
        db,
        replacement,
        {
          organizationId,
          invitationId: row.id,
          email: row.email,
          resend: true,
          expectedGeneration: 1,
          requestId: randomUUID(),
        },
        {
          reserve: async (trx, identity, at) => {
            const beforeWait = await trx
              .selectFrom('auth.invitation')
              .select(sql<boolean>`"expiresAt" > clock_timestamp()`.as('live'))
              .where('id', '=', row.id)
              .executeTakeFirstOrThrow()
            expect(beforeWait.live, 'the invitation is live when it reaches the budget lock').toBe(
              true,
            )
            return reserveInvitationEmailBudget(
              trx,
              identity,
              { secret: 'synthetic-expiry-budget' },
              at,
            )
          },
        },
      )
      await expect
        .poll(
          async () =>
            Number(
              (
                await owned.pool.query<{ count: string }>(
                  `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND $1 = ANY (pg_blocking_pids(pid))`,
                  [holderPid],
                )
              ).rows[0]?.count,
            ),
          { timeout: 3_000, interval: 10 },
        )
        .toBe(1)
      await expect
        .poll(
          async () =>
            (
              await db
                .selectFrom('auth.invitation')
                .select(sql<boolean>`"expiresAt" <= clock_timestamp()`.as('expired'))
                .where('id', '=', row.id)
                .executeTakeFirstOrThrow()
            ).expired,
          { timeout: 3_000, interval: 10 },
        )
        .toBe(true)
      releaseBudget.resolve()
      const fresh = await pending
      expect(fresh.id, 'expiry during a budget wait requires a fresh ID').not.toBe(row.id)
      expect(fresh.inviterId).toBe(replacement.userId)
      expect(fresh.delivery).toMatchObject({ generation: 1, state: 'queued' })
      expect(
        await storedInvitation(row.id),
        'the newly expired invitation is retired',
      ).toMatchObject({ status: 'canceled' })
      expect(await delivery(row.id), 'the newly expired delivery is finalized').toMatchObject({
        state: 'skipped',
        lease_id: null,
        lease_until: null,
      })
      expect(
        await db
          .selectFrom('auth.invitation')
          .select('id')
          .where('status', '=', 'pending')
          .execute(),
      ).toEqual([{ id: fresh.id }])
    } finally {
      releaseBudget.resolve()
      await holder
      await pending?.catch(() => {})
    }
  }

  it('replaces a live invitation that expires while waiting for the real shared mail-budget lock', async () => {
    await verifyExpiryDuringBudgetWait()
  })

  it('detects prelocking only already-expired invitations before the budget wait', async () => {
    const copy = await sourceCopy(
      new URL('../../auth/src/invitations.ts', import.meta.url),
      ".select(['id', 'expiresAt'])",
      ".select(['id', 'expiresAt']).where('expiresAt', '<=', now)",
    )
    await expect(verifyExpiryDuringBudgetWait(copy.manageInvitation)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('the newly expired invitation is retired'),
    })
  })

  async function verifyPostCommitReplacementId(retired: boolean, manage = manageInvitation) {
    const row = await invitation()
    await expire(row.id)
    let failure: unknown
    try {
      await manage(
        db,
        replacement,
        {
          organizationId,
          invitationId: row.id,
          email: row.email,
          resend: true,
          expectedGeneration: 1,
          requestId: randomUUID(),
        },
        {
          enqueue: async ({ invitationId: queuedId }) => {
            if (retired)
              await db
                .updateTable('auth.invitation')
                .set({ status: 'canceled' })
                .where('id', '=', queuedId)
                .execute()
            throw new Error('synthetic queue failure')
          },
        },
      )
    } catch (error) {
      failure = error
    }
    const fresh = await db
      .selectFrom('auth.invitation')
      .select('id')
      .where('organizationId', '=', organizationId)
      .where('id', '!=', row.id)
      .executeTakeFirstOrThrow()
    expect(failure, 'a post-commit failure identifies the saved replacement').toMatchObject({
      body: {
        code: retired ? 'INVITATION_INELIGIBLE' : 'INVITATION_DELIVERY_UNAVAILABLE',
        invitationId: fresh.id,
      },
    })
  }

  it.each([false, true])(
    'identifies the saved replacement after a post-commit queue error, retired=%s',
    async (retired) => {
      await verifyPostCommitReplacementId(retired)
    },
  )

  it.each([
    [false, '...(resend && !admitted.existing ? { invitationId: admitted.id } : {}),', ''],
    [
      true,
      'if (retired) throw ineligible(resend && !admitted.existing ? admitted.id : undefined)',
      'if (retired) throw ineligible()',
    ],
  ] as const)(
    'detects losing the saved replacement ID after a post-commit queue error, retired=%s',
    async (retired, before, after) => {
      const copy = await sourceCopy(
        new URL('../../auth/src/invitations.ts', import.meta.url),
        before,
        after,
      )
      await expect(
        verifyPostCommitReplacementId(retired, copy.manageInvitation),
      ).rejects.toMatchObject({
        name: 'AssertionError',
        message: expect.stringContaining('a post-commit failure identifies the saved replacement'),
      })
    },
  )

  it('creates a fresh generation at the old invitation generation cap without resurrecting its ID', async () => {
    const row = await invitation()
    await expire(row.id)
    await db
      .updateTable('invitation_deliveries')
      .set({ generation: 32 })
      .where('invitation_id', '=', row.id)
      .execute()
    const fresh = await resend({ ...row, delivery: { ...row.delivery, generation: 32 } })
    expect(fresh.id).not.toBe(row.id)
    expect(fresh.delivery).toMatchObject({ generation: 1, state: 'queued' })
    expect(await delivery(row.id)).toMatchObject({ generation: 32, state: 'skipped' })
  })

  it('the ordinary invite form atomically retires every expired pending row for the address', async () => {
    const row = await invitation()
    await expire(row.id)
    const duplicate = await db
      .insertInto('auth.invitation')
      .values({
        inviterId: original.userId,
        organizationId,
        email: row.email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() - 1_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const fresh = await manageInvitation(db, replacement, { organizationId, email: row.email })
    expect(fresh.id).not.toBe(row.id)
    expect(fresh.id).not.toBe(duplicate.id)
    expect(fresh.inviterId).toBe(replacement.userId)
    expect(await storedInvitation(row.id)).toMatchObject({ status: 'canceled' })
    expect(await storedInvitation(duplicate.id)).toMatchObject({ status: 'canceled' })
    expect(await delivery(row.id)).toMatchObject({ state: 'skipped' })
    expect(
      await db.selectFrom('auth.invitation').select('id').where('status', '=', 'pending').execute(),
    ).toEqual([{ id: fresh.id }])
    await expect(resend(row)).rejects.toMatchObject({ body: { code: 'INVITATION_INELIGIBLE' } })
  })

  async function verifyPendingLimit(manage = manageInvitation) {
    const row = await invitation()
    await expire(row.id)
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
    expect(
      await storedInvitation(row.id),
      'a refused replacement leaves the old invitation intact',
    ).toMatchObject({ status: 'pending' })
    expect(await delivery(row.id)).toMatchObject({ generation: 1, state: 'queued' })
    expect(await db.selectFrom('auth.invitation').select('id').execute()).toHaveLength(101)
  }

  it('applies the active pending limit before replacing an expired invitation', async () => {
    await verifyPendingLimit()
  })

  it('applies the normal admission budget before replacement and rolls back without canceling the old invitation', async () => {
    const row = await invitation()
    await expire(row.id)
    const reserve = (
      trx: Db,
      identity: { userId: string; organizationId: string; email: string },
      at: Date,
    ) =>
      reserveInvitationEmailBudget(
        trx,
        identity,
        { secret: 'synthetic-recovery-budget', invitationTeamMaxPerHour: 1 },
        at,
      )
    await db
      .transaction()
      .execute((trx) =>
        reserve(
          trx,
          { userId: replacement.userId, organizationId, email: `${randomUUID()}@example.test` },
          now(),
        ),
      )
    await expect(
      manageInvitation(
        db,
        replacement,
        {
          organizationId,
          invitationId: row.id,
          email: row.email,
          resend: true,
          expectedGeneration: 1,
          requestId: randomUUID(),
        },
        { reserve },
      ),
    ).rejects.toMatchObject({ body: { code: 'INVITATION_RATE_LIMITED' } })
    expect(await storedInvitation(row.id)).toMatchObject({ status: 'pending' })
    expect(await delivery(row.id)).toMatchObject({ generation: 1, state: 'queued' })
    expect(await db.selectFrom('auth.invitation').select('id').execute()).toEqual([{ id: row.id }])
    expect(
      await db.selectFrom('invitation_email_requests').select('user_id').execute(),
    ).toHaveLength(1)
  })

  it('detects removing the replacement pending-cap protection through a real assertion failure', async () => {
    const copy = await sourceCopy(
      new URL('../../auth/src/invitations.ts', import.meta.url),
      'if (Number(pending.count) >= 100)',
      'if (Number(pending.count) > 100)',
    )
    await expect(verifyPendingLimit(copy.manageInvitation)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it.each([
    [
      'renewing an expired invitation in place',
      '        invitation = undefined\n        delivery = undefined',
      `        if (invitation) invitation = await trx.updateTable('auth.invitation')
          .set({ status: 'pending', expiresAt: new Date(now.getTime() + lifetime) })
          .where('id', '=', invitation.id).returningAll().executeTakeFirstOrThrow()
        delivery = undefined`,
      'an expired invitation requires a new ID',
    ],
    [
      'keeping the old inviter on a fresh invitation',
      'inviterId: actor.userId,',
      `inviterId: (await trx.selectFrom('auth.invitation').select('inviterId')
        .where('organizationId', '=', organizationId).where('email', '=', email)
        .orderBy('createdAt').executeTakeFirstOrThrow()).inviterId,`,
      'the new invitation trusts the acting administrator',
    ],
    [
      'leaving the old invitation link usable',
      ".set({ status: 'canceled' })",
      ".set({ status: 'pending', expiresAt: new Date(now.getTime() + lifetime) })",
      'the old invitation link remains unusable after replacement',
    ],
  ] as const)(
    'detects %s through the same real PostgreSQL replacement assertion',
    async (_name, before, after, assertion) => {
      const copy = await sourceCopy(
        new URL('../../auth/src/invitations.ts', import.meta.url),
        before,
        after,
      )
      await expect(verifyReplacement(copy.manageInvitation)).rejects.toMatchObject({
        name: 'AssertionError',
        message: expect.stringContaining(assertion),
      })
    },
  )

  async function verifyActiveDuplicate(manage = manageInvitation) {
    const row = await invitation()
    await expire(row.id)
    const active = await db
      .insertInto('auth.invitation')
      .values({
        inviterId: original.userId,
        organizationId,
        email: row.email,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await expect(resend(row, manage)).rejects.toMatchObject({
      body: { code: 'INVITATION_CONFLICT' },
    })
    expect(await storedInvitation(row.id)).toMatchObject({ status: 'pending' })
    expect(await delivery(row.id)).toMatchObject({ state: 'queued' })
    expect(
      await db
        .selectFrom('auth.invitation')
        .select('id')
        .where('status', '=', 'pending')
        .where('expiresAt', '>', now())
        .execute(),
    ).toEqual([{ id: active.id }])
  }

  it('refuses replacement when another active invitation already exists', async () => {
    await verifyActiveDuplicate()
  })

  it('detects removing the active duplicate protection through a real assertion failure', async () => {
    const copy = await sourceCopy(
      new URL('../../auth/src/invitations.ts', import.meta.url),
      'if (otherPending) throw conflict()',
      'void otherPending',
    )
    await expect(verifyActiveDuplicate(copy.manageInvitation)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

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
