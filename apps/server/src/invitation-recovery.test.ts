import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import {
  cancelTeamInvitation,
  createAuth,
  createAuthPool,
  createCallerResolver,
  TeamManagementError,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { deliverInvitationEmail } from '@hourmere/notifications'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { teamInvitationRoutes } from './routes/team-invitations.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4472'
const secret = 'synthetic-invitation-recovery-secret-000000000000'
const path = '/api/v1/team/invitations'

describe.skipIf(!serverUrl)('invitation recovery over HTTP and PostgreSQL', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let app: ReturnType<typeof createApp>
  let owner: TestUser
  let recipient: TestUser
  let teamId: string
  let ownerCookie: string
  let recipientCookie: string
  let invitationId: string
  let failEnqueue: 'unavailable' | 'ineligible' | false = false

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_recovery' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, { mode: 'open', allowedDomains: [] })
    const auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup: { mode: 'open', allowedDomains: [] },
      mailer: { send: async () => {} },
      enqueueInvitationEmail: async ({ invitationId: queuedId }) => {
        if (failEnqueue === 'ineligible')
          await db
            .updateTable('auth.invitation')
            .set({ status: 'canceled' })
            .where('id', '=', queuedId)
            .execute()
        if (failEnqueue) throw new Error('synthetic queue failure')
      },
    })
    app = createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: [teamInvitationRoutes({ db, invitationMailLimits: { secret } })],
    })
  })
  beforeEach(async () => {
    failEnqueue = false
    await db.deleteFrom('auth.organization').execute()
    await db.deleteFrom('auth.user').execute()
    await db.deleteFrom('invitation_email_requests').execute()
    await db.deleteFrom('notification_email_sends').execute()
    owner = await createTestUser(db, 'Recovery owner')
    recipient = await createTestUser(db, 'Recovery recipient')
    teamId = (await createTestTeam(db, [{ user: owner, role: 'owner' }])).id
    ownerCookie = await session(owner, teamId)
    recipientCookie = await session(recipient, recipient.principal.organization.id)
    invitationId = (
      await db
        .insertInto('auth.invitation')
        .values({
          inviterId: owner.id,
          organizationId: teamId,
          email: recipient.email,
          role: 'member',
          status: 'pending',
          createdAt: new Date(Date.now() - 120_000),
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    await db
      .insertInto('invitation_deliveries')
      .values({
        invitation_id: invitationId,
        state: 'queued',
        authorized_by_user_id: owner.id,
        generation_started_at: new Date(Date.now() - 120_000),
        updated_at: new Date(Date.now() - 120_000),
      })
      .execute()
  })
  afterAll(async () => {
    try {
      await authPool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function session(user: TestUser, organizationId: string) {
    const token = randomUUID()
    await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        updatedAt: new Date(),
        activeOrganizationId: organizationId,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
  }
  function post(url: string, cookie: string, body: unknown, expected = teamId) {
    return Promise.resolve(
      app.request(url, {
        method: 'POST',
        headers: {
          origin,
          cookie,
          'content-type': 'application/json',
          'x-expected-organization-id': expected,
        },
        body: JSON.stringify(body),
      }),
    )
  }
  const cancel = () => post(`${path}/${invitationId}/cancel`, ownerCookie, {})
  const nativeCancel = () =>
    post('/api/auth/organization/cancel-invitation', ownerCookie, { invitationId })
  const accept = () =>
    post('/api/auth/organization/accept-invitation', recipientCookie, { invitationId })
  const resend = () =>
    post('/api/auth/organization/invite-member', ownerCookie, {
      organizationId: teamId,
      invitationId,
      email: recipient.email,
      role: 'member',
      resend: true,
      expectedGeneration: 1,
      requestId: randomUUID(),
    })
  async function detail(
    cookie = ownerCookie,
    id = invitationId,
    headers: Record<string, string> = {},
  ) {
    return app.request(`${path}/${id}`, {
      headers: { cookie, 'x-expected-organization-id': teamId, ...headers },
    })
  }
  const member = () =>
    db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', teamId)
      .where('userId', '=', recipient.id)
      .executeTakeFirst()

  async function blockedBy(blockers: number[], count: number) {
    let pids: number[] = []
    await vi.waitFor(
      async () => {
        const result = await owned.pool.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND pg_blocking_pids(pid) && $1::int[]`,
          [blockers],
        )
        pids = result.rows.map((row) => row.pid)
        expect(
          pids.length,
          'both requests reached their PostgreSQL lock barriers',
        ).toBeGreaterThanOrEqual(count)
      },
      { timeout: 3000, interval: 10 },
    )
    return pids
  }
  // The holder makes the arrival order visible in pg_stat_activity before releasing it.
  async function race(
    first: () => Promise<Response>,
    second: () => Promise<Response>,
    lock: 'team' | 'invitation' = 'team',
  ) {
    const holder = await owned.pool.connect()
    const pending: Promise<Response>[] = []
    try {
      await holder.query('BEGIN')
      if (lock === 'team')
        await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [teamId])
      else
        await holder.query('SELECT id FROM auth.invitation WHERE id=$1 FOR UPDATE', [invitationId])
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid as number
      pending.push(first())
      const [firstPid] = await blockedBy([pid], 1)
      pending.push(second())
      await blockedBy([pid, firstPid as number], 2)
      await holder.query('COMMIT')
      return await Promise.all(pending)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await Promise.allSettled(pending)
    }
  }

  it.each(['REST', 'native'] as const)(
    'cancellation wins against acceptance through %s and the canceled link cannot join',
    async (protocol) => {
      const [canceled, refused] = await race(protocol === 'REST' ? cancel : nativeCancel, accept)
      expect(canceled?.status).toBe(200)
      expect(await canceled?.json()).toMatchObject({ status: 'canceled' })
      expect(refused?.ok).toBe(false)
      expect(await member()).toBeUndefined()
      expect((await accept()).ok).toBe(false)
      expect(await (await detail()).json()).toMatchObject({
        status: 'canceled',
        resendAllowed: false,
      })
    },
  )
  it.each(['REST', 'native'] as const)(
    'acceptance wins against cancellation through %s and the joined member remains',
    async (protocol) => {
      const [joined, canceled] = await race(accept, protocol === 'REST' ? cancel : nativeCancel)
      expect(joined?.status).toBe(200)
      expect(canceled?.status).toBe(200)
      expect(await canceled?.json()).toMatchObject({ status: 'accepted' })
      expect(await member(), 'cancel never removes a joined member').toBeDefined()
      expect(await (await detail()).json()).toMatchObject({
        status: 'accepted',
        resendAllowed: false,
      })
    },
  )
  it.each(['REST', 'native'] as const)(
    'cancellation through %s preserves a membership after acceptance and member insertion both commit',
    async (protocol) => {
      expect((await accept()).status).toBe(200)
      const joinedMember = await member()
      expect(
        joinedMember,
        'acceptance has committed its member row before cancellation',
      ).toBeDefined()
      const canceled = await (protocol === 'REST' ? cancel() : nativeCancel())
      expect(canceled.status).toBe(200)
      expect(await canceled.json()).toMatchObject({ status: 'accepted' })
      expect(await member(), 'cancel never removes a joined member after both commits').toEqual(
        joinedMember,
      )
    },
  )
  it('replaces an expired invitation through the native action and refuses its old link', async () => {
    const current = await createTestUser(db, 'Replacement recovery administrator')
    await db
      .insertInto('auth.member')
      .values({ userId: current.id, organizationId: teamId, role: 'admin', createdAt: new Date() })
      .execute()
    ownerCookie = await session(current, teamId)
    await db
      .updateTable('auth.invitation')
      .set({ expiresAt: new Date(Date.now() - 3_600_000) })
      .where('id', '=', invitationId)
      .execute()
    const response = await resend()
    expect(response.status).toBe(200)
    const fresh = (await response.json()) as { id: string }
    expect(fresh.id, 'expired links are replaced with a new invitation ID').not.toBe(invitationId)
    expect(
      await db
        .selectFrom('auth.invitation')
        .selectAll()
        .where('id', '=', fresh.id)
        .executeTakeFirst(),
    ).toMatchObject({ inviterId: current.id, status: 'pending' })
    expect(await (await detail()).json()).toMatchObject({
      status: 'canceled',
      resendAllowed: false,
    })
    expect((await accept()).ok, 'the replaced invitation link cannot join').toBe(false)
    expect(await member()).toBeUndefined()
    const joined = await post('/api/auth/organization/accept-invitation', recipientCookie, {
      invitationId: fresh.id,
    })
    expect(joined.status).toBe(200)
    expect(await member(), 'the new invitation link can join').toBeDefined()
  })
  it.each([false, true])(
    'queue failure exposes the saved invitation ID only for expired replacement=%s',
    async (expired) => {
      if (expired)
        await db
          .updateTable('auth.invitation')
          .set({ expiresAt: new Date(Date.now() - 3_600_000) })
          .where('id', '=', invitationId)
          .execute()
      failEnqueue = 'unavailable'
      const response = await resend()
      expect(response.status).toBe(503)
      const body = (await response.json()) as { code: string; invitationId?: string }
      expect(body.code).toBe('INVITATION_DELIVERY_UNAVAILABLE')
      const pending = await db
        .selectFrom('auth.invitation')
        .select('id')
        .where('organizationId', '=', teamId)
        .where('status', '=', 'pending')
        .execute()
      expect(pending).toHaveLength(1)
      if (expired) {
        expect(body.invitationId).toBe(pending[0]?.id)
        expect(body.invitationId).not.toBe(invitationId)
        expect(await (await detail()).json()).toMatchObject({ status: 'canceled' })
        expect(await (await detail(ownerCookie, body.invitationId)).json()).toMatchObject({
          status: 'pending',
          generation: 1,
          delivery: { state: 'queued' },
        })
      } else {
        expect(body.invitationId).toBeUndefined()
        expect(pending[0]?.id).toBe(invitationId)
      }
    },
  )
  it.each([false, true])(
    'post-commit cancellation exposes the saved invitation ID only for expired replacement=%s',
    async (expired) => {
      if (expired)
        await db
          .updateTable('auth.invitation')
          .set({ expiresAt: new Date(Date.now() - 3_600_000) })
          .where('id', '=', invitationId)
          .execute()
      failEnqueue = 'ineligible'
      const response = await resend()
      expect(response.status).toBe(409)
      const body = (await response.json()) as { code: string; invitationId?: string }
      expect(body.code).toBe('INVITATION_INELIGIBLE')
      if (expired) {
        const fresh = await db
          .selectFrom('auth.invitation')
          .select('id')
          .where('organizationId', '=', teamId)
          .where('id', '!=', invitationId)
          .executeTakeFirstOrThrow()
        expect(body.invitationId).toBe(fresh.id)
        expect(await (await detail(ownerCookie, fresh.id)).json()).toMatchObject({
          status: 'canceled',
          generation: 1,
        })
      } else expect(body.invitationId).toBeUndefined()
      expect(await (await detail()).json()).toMatchObject({ status: 'canceled' })
    },
  )
  it('cancellation beats a resend waiting behind its team lock', async () => {
    const [canceled, refused] = await race(cancel, resend, 'invitation')
    expect(canceled?.status).toBe(200)
    expect(refused?.status).toBe(409)
    expect(await refused?.json()).toMatchObject({ code: 'INVITATION_INELIGIBLE' })
    expect(await (await detail()).json()).toMatchObject({ status: 'canceled', generation: 1 })
  })
  it('a resend that wins its lock is followed by the final canceled state, not a stale queued success', async () => {
    const [queued, canceled] = await race(resend, cancel, 'invitation')
    expect(queued?.status).toBe(200)
    expect(canceled?.status).toBe(200)
    expect(await (await detail()).json()).toMatchObject({
      status: 'canceled',
      generation: 2,
      resendAllowed: false,
    })
    expect(await member()).toBeUndefined()
  })
  it('reports cancellation during in-flight SMTP separately from the eventual mail server acceptance', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const send = deliverInvitationEmail(
      {
        db,
        publicUrl: origin,
        secret,
        smtpConfigured: true,
        log: () => {},
        mailer: {
          send: async () => {
            entered.resolve()
            await release.promise
          },
        },
      },
      { invitationId, generation: 1 },
    )
    try {
      await entered.promise
      const response = await cancel()
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        status: 'canceled',
        delivery: { state: 'sending' },
      })
    } finally {
      release.resolve()
      await send
    }
    expect(await (await detail()).json()).toMatchObject({
      status: 'canceled',
      delivery: { state: 'smtp_accepted' },
    })
    expect((await accept()).ok).toBe(false)
    expect(await member()).toBeUndefined()
  })
  it('advertises a deliverable resend under the acting administrator after the original inviter is demoted', async () => {
    const current = await createTestUser(db, 'Current recovery administrator')
    await db
      .insertInto('auth.member')
      .values({ userId: current.id, organizationId: teamId, role: 'owner', createdAt: new Date() })
      .execute()
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', teamId)
      .where('userId', '=', owner.id)
      .execute()
    ownerCookie = await session(current, teamId)
    expect(await (await detail()).json()).toMatchObject({
      resendAllowed: true,
      resendDeniedReason: null,
      generation: 1,
    })
    expect((await resend()).status).toBe(200)
    const messages: string[] = []
    await deliverInvitationEmail(
      {
        db,
        publicUrl: origin,
        secret,
        smtpConfigured: true,
        log: () => {},
        mailer: {
          send: async (message) => {
            messages.push(message.text)
          },
        },
      },
      { invitationId, generation: 2 },
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Current recovery administrator')
    expect(messages[0]).not.toContain('Recovery owner')
    expect(await (await detail()).json()).toMatchObject({
      generation: 2,
      delivery: { state: 'smtp_accepted' },
    })
  })
  it('binds detail and cancellation to the team, current manager and same-origin browser session', async () => {
    for (const id of [
      randomUUID(),
      (
        await db
          .insertInto('auth.invitation')
          .values({
            inviterId: owner.id,
            organizationId: recipient.principal.organization.id,
            email: recipient.email,
            role: 'member',
            status: 'pending',
            expiresAt: new Date(Date.now() + 60_000),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
    ]) {
      expect((await detail(ownerCookie, id)).status).toBe(403)
      expect((await post(`${path}/${id}/cancel`, ownerCookie, {})).status).toBe(403)
    }
    expect((await detail(recipientCookie)).status).toBe(403)
    expect(
      (await detail(ownerCookie, invitationId, { authorization: 'Bearer invalid' })).status,
    ).toBe(403)
    expect(
      (
        await app.request(`${path}/${invitationId}/cancel`, {
          method: 'POST',
          headers: {
            cookie: ownerCookie,
            origin: 'http://foreign.example',
            'content-type': 'application/json',
            'x-expected-organization-id': teamId,
          },
          body: '{}',
        })
      ).status,
    ).toBe(403)
    expect(
      (await post(`${path}/${invitationId}/cancel`, ownerCookie, { removeMember: true })).status,
    ).toBe(400)
    expect(await (await detail()).json()).toMatchObject({ status: 'pending' })
  })

  async function verifyJoinedMember(cancelOperation = cancelTeamInvitation) {
    expect((await accept()).status).toBe(200)
    const previous = await member()
    expect(previous).toBeDefined()
    const result = await db
      .transaction()
      .execute((trx) =>
        cancelOperation(
          trx,
          { userId: owner.id, organizationId: teamId, role: 'owner' },
          invitationId,
        ),
      )
    expect(result.status, 'cancel preserves completed acceptance').toBe('accepted')
    expect(await member(), 'cancel never removes a joined member').toEqual(previous)
  }
  function cancellationCopy(mutation?: 'member' | 'lifecycle' | 'team') {
    let source = readFileSync(
      new URL('../../../packages/auth/src/invitation-cancellation.ts', import.meta.url),
      'utf8',
    )
    const guard = "if (invitation.status !== 'pending') return invitation"
    expect(source).toContain(guard)
    if (mutation === 'member')
      source = source.replace(
        guard,
        `
      await db.deleteFrom('auth.member').where('organizationId', '=', actor.organizationId)
        .where('userId', 'in', db.selectFrom('auth.user').select('id').where('email', '=', invitation.email)).execute()
      ${guard}`,
      )
    if (mutation === 'lifecycle')
      source = source.replace(guard, '').replace(".where('status', '=', 'pending')", '')
    if (mutation === 'team')
      source = source.replace(".where('organizationId', '=', actor.organizationId)", '')
    const javascript = stripTypeScriptTypes(
      source.replace(/^import[\s\S]*?from '[^']+'\n/gm, ''),
    ).replace(/\bexport /g, '')
    return new Function('TeamManagementError', `${javascript}; return cancelTeamInvitation`)(
      TeamManagementError,
    ) as typeof cancelTeamInvitation
  }
  it('keeps a joined membership through the unchanged cancellation source copy', () =>
    verifyJoinedMember(cancellationCopy()))
  it('detects a cancellation that removes a joined member through a real assertion failure', async () => {
    await expect(verifyJoinedMember(cancellationCopy('member'))).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('cancel never removes a joined member'),
    })
  })
  it('detects cancellation overwriting a completed acceptance through a real assertion failure', async () => {
    await expect(verifyJoinedMember(cancellationCopy('lifecycle'))).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('cancel preserves completed acceptance'),
    })
  })
  async function verifyTargetTeam(cancelOperation = cancelTeamInvitation) {
    await expect(
      db.transaction().execute((trx) =>
        cancelOperation(
          trx,
          {
            userId: owner.id,
            organizationId: recipient.principal.organization.id,
            role: 'owner',
          },
          invitationId,
        ),
      ),
    ).rejects.toMatchObject({ code: 'team_management_access_denied' })
    expect(await (await detail()).json()).toMatchObject({ status: 'pending' })
  }
  it('scopes the unchanged cancellation source copy to its authorized team', () =>
    verifyTargetTeam(cancellationCopy()))
  it('detects cancellation crossing teams through a real assertion failure', async () => {
    await expect(verifyTargetTeam(cancellationCopy('team'))).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
})
