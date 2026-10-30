// Better Auth 1.7.10's organization invitation contract, through Hourmere's real handler and
// throwaway Postgres. Hook probes add callbacks to the existing plugin before initialization;
// ordinary requests use createAuth unchanged and never send to an external mail provider.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createCallerResolver,
  ensurePersonalOrganization,
  type SignupPolicy,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { pressConfirmButton } from './sign-in-confirm-testing.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:3000'
const OPEN: SignupPolicy = { mode: 'open', allowedDomains: [] }

interface Invitation {
  id: string
  email: string
  role: string
  organizationId: string
  inviterId: string
  status: string
  expiresAt: string
  createdAt: string
}

interface HookInput {
  invitation: { id?: string; email: string; status?: string }
  organization: { id: string }
}
interface OrganizationOptions {
  requireEmailVerificationOnInvitation?: boolean
  sendInvitationEmail?: (input: HookInput) => Promise<void>
  organizationHooks: Record<string, (input: HookInput) => unknown>
}

const cookieHeader = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')

describe.skipIf(!serverUrl)('team invitation contract', () => {
  let testDb: TestDatabase
  let db: Db
  let pool: pg.Pool
  const outbox: MailMessage[] = []

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string, undefined, { tag: 'team_join' })
    db = createDb(testDb.pool)
    // One reused auth pool plus the test helper's pool; no per-test connection growth.
    pool = createAuthPool(testDb.url, OPEN)
  })
  afterAll(async () => {
    await pool?.end()
    await testDb?.drop()
  })
  beforeEach(async () => {
    await testDb.pool.query('DELETE FROM auth.organization')
    await testDb.pool.query('DELETE FROM auth."user"')
    outbox.length = 0
  })
  afterEach(() => vi.restoreAllMocks())

  function instance(instrument?: (options: OrganizationOptions) => void, nativeProbe = false) {
    const secret = randomBytes(32).toString('base64')
    const auth = createAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup: OPEN,
      mailer: { send: async (message) => void outbox.push(message) },
    })
    // Native dependency probes explicitly omit the product admission hook.
    if (nativeProbe) {
      const hookOptions: { hooks?: typeof auth.options.hooks } = auth.options
      hookOptions.hooks = undefined
    }
    // organization() closes over this same options object; this changes only the isolated
    // fixture. Production currently has neither sendInvitationEmail nor after-create hooks.
    const plugin = auth.options.plugins.find((candidate) => candidate.id === 'organization')
    const options = (plugin as unknown as { options: OrganizationOptions }).options
    instrument?.(options)
    const app = createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
    })
    return { app, auth, secret, options }
  }
  type Instance = ReturnType<typeof instance>

  const post = async (app: Instance['app'], action: string, cookie: string, body: unknown) => {
    const input = body as { organizationId?: string; invitationId?: string }
    const expected =
      input.organizationId ??
      (action === 'cancel-invitation' && input.invitationId
        ? (
            await db
              .selectFrom('auth.invitation')
              .select('organizationId')
              .where('id', '=', input.invitationId)
              .executeTakeFirst()
          )?.organizationId
        : undefined)
    return app.request(`/api/auth/organization/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        cookie,
        ...(expected && action !== 'set-active' ? { 'x-expected-organization-id': expected } : {}),
      },
      body: JSON.stringify(body),
    })
  }
  const get = (app: Instance['app'], id: string, cookie = '') =>
    app.request(`/api/auth/organization/get-invitation?id=${id}`, { headers: { cookie } })

  /** A genuine signed session for a fixture identity, including legacy unverified accounts. */
  async function account(i: Instance, email: string, verified = true) {
    const inserted = await testDb.pool.query<{ id: string }>(
      `INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('Fixture', $1, $2) RETURNING id`,
      [email, verified],
    )
    const id = inserted.rows[0]?.id as string
    const personal = await ensurePersonalOrganization(db, id)
    const token = randomBytes(24).toString('base64url')
    await testDb.pool.query(
      `INSERT INTO auth.session ("expiresAt", token, "updatedAt", "userId", "activeOrganizationId")
       VALUES ($1, $2, now(), $3, $4)`,
      [new Date(Date.now() + 3_600_000), token, id, personal],
    )
    const signature = createHmac('sha256', i.secret).update(token).digest('base64')
    return {
      id,
      personal,
      token,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function team(i: Instance, cookie: string) {
    const created = await post(i.app, 'create', cookie, {
      name: 'Inviting team',
      slug: randomUUID(),
    })
    expect(created.status).toBe(200)
    return (await created.json()) as { id: string; name: string; slug: string }
  }
  async function invite(i: Instance, cookie: string, organizationId: string, email: string) {
    const response = await post(i.app, 'invite-member', cookie, {
      email,
      role: 'member',
      organizationId,
    })
    expect(response.status).toBe(200)
    const { delivery: _delivery, ...invitation } = (await response.json()) as Invitation & {
      delivery: unknown
    }
    return invitation
  }
  async function state(organizationId: string) {
    // This independent connection can see only committed rows, including inside callbacks.
    return (
      await testDb.pool.query<{ status: string; members: number }>(
        `SELECT i.status, (SELECT count(*)::int FROM auth.member WHERE "organizationId" = $1) AS members
         FROM auth.invitation i WHERE i."organizationId" = $1 ORDER BY i.id`,
        [organizationId],
      )
    ).rows
  }
  const active = async (token: string) =>
    (
      await testDb.pool.query<{ id: string }>(
        'SELECT "activeOrganizationId" AS id FROM auth.session WHERE token = $1',
        [token],
      )
    ).rows[0]?.id

  it('returns the actual invite/get/accept bodies, normalizes only email case, and switches the accepting session', async () => {
    const i = instance()
    const owner = await account(i, 'owner@example.com')
    const recipient = await account(i, 'recipient@example.com')
    const org = await team(i, owner.cookie)
    const invitation = await invite(i, owner.cookie, org.id, 'RECIPIENT@Example.COM')
    expect(invitation).toEqual({
      id: expect.any(String),
      email: 'recipient@example.com',
      role: 'member',
      organizationId: org.id,
      inviterId: owner.id,
      status: 'pending',
      expiresAt: expect.any(String),
      createdAt: expect.any(String),
    })
    expect(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt)).toBeCloseTo(
      48 * 3_600_000,
      -3,
    )
    const viewed = await get(i.app, invitation.id, recipient.cookie)
    expect(viewed.status).toBe(200)
    expect(await viewed.json()).toEqual({
      ...invitation,
      organizationName: org.name,
      organizationSlug: org.slug,
      inviterEmail: 'owner@example.com',
    })
    expect(await active(recipient.token)).toBe(recipient.personal)
    const accepted = await post(i.app, 'accept-invitation', recipient.cookie, {
      invitationId: invitation.id,
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({
      invitation: { ...invitation, status: 'accepted' },
      member: {
        id: expect.any(String),
        organizationId: org.id,
        userId: recipient.id,
        role: 'member',
        createdAt: expect.any(String),
      },
    })
    expect(await active(recipient.token)).toBe(org.id)
    expect(await state(org.id)).toEqual([{ status: 'accepted', members: 2 }])
    // No invitation mail callback is configured; creating a pending invitation sends nothing.
    expect(i.options.sendInvitationEmail).toBeUndefined()
    expect(outbox).toEqual([])
  })

  it('requires a signed-in, verified exact recipient for both lookup and acceptance', async () => {
    const i = instance()
    const owner = await account(i, 'owner@example.com')
    const wrong = await account(i, 'recipient+alias@example.com')
    const recipient = await account(i, 'recipient@example.com', false)
    const org = await team(i, owner.cookie)
    const invitation = await invite(i, owner.cookie, org.id, 'recipient@example.com')
    const attempts = [
      { cookie: '', status: 401, code: 'UNAUTHORIZED' },
      { cookie: wrong.cookie, status: 403, code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION' },
      { cookie: recipient.cookie, status: 403, code: 'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION' },
    ]
    for (const attempt of attempts) {
      const viewed = await get(i.app, invitation.id, attempt.cookie)
      expect(viewed.status).toBe(attempt.status)
      if (attempt.cookie) expect(await viewed.json()).toMatchObject({ code: attempt.code })
      const accepted = await post(i.app, 'accept-invitation', attempt.cookie, {
        invitationId: invitation.id,
      })
      expect(accepted.status).toBe(attempt.status)
      expect(await accepted.json()).toMatchObject({
        code:
          attempt.cookie === recipient.cookie
            ? 'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION'
            : attempt.code,
      })
      expect(await state(org.id)).toEqual([{ status: 'pending', members: 1 }])
      expect(await active(recipient.token)).toBe(recipient.personal)
    }
  })

  it.each(['expired', 'canceled', 'accepted'] as const)(
    'refuses lookup and acceptance of an %s invitation without adding a member',
    async (lifecycle) => {
      const i = instance()
      const owner = await account(i, 'owner@example.com')
      const recipient = await account(i, 'recipient@example.com')
      const org = await team(i, owner.cookie)
      const invitation = await invite(i, owner.cookie, org.id, 'recipient@example.com')
      await testDb.pool.query(
        `UPDATE auth.invitation SET status = $2, "expiresAt" = $3 WHERE id = $1`,
        [
          invitation.id,
          lifecycle === 'expired' ? 'pending' : lifecycle,
          new Date(Date.now() + (lifecycle === 'expired' ? -60_000 : 60_000)),
        ],
      )
      expect((await get(i.app, invitation.id, recipient.cookie)).status).toBe(400)
      const accepted = await post(i.app, 'accept-invitation', recipient.cookie, {
        invitationId: invitation.id,
      })
      expect(accepted.status).toBe(400)
      expect(await accepted.json()).toMatchObject({ code: 'INVITATION_NOT_FOUND' })
      expect(await state(org.id)).toEqual([
        { status: lifecycle === 'expired' ? 'pending' : lifecycle, members: 1 },
      ])
      expect(await active(recipient.token)).toBe(recipient.personal)
    },
  )

  it('allows owner/admin invitation management, refuses ordinary members and outsiders, and returns a bare canceled invitation', async () => {
    const i = instance()
    const owner = await account(i, 'owner@example.com')
    const admin = await account(i, 'admin@example.com')
    const member = await account(i, 'member@example.com')
    const outsider = await account(i, 'outsider@example.com')
    const org = await team(i, owner.cookie)
    for (const [user, role] of [
      [admin, 'admin'],
      [member, 'member'],
    ] as const) {
      await testDb.pool.query(
        `INSERT INTO auth.member ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, now())`,
        [org.id, user.id, role],
      )
      expect(
        (await post(i.app, 'set-active', user.cookie, { organizationId: org.id })).status,
      ).toBe(200)
    }
    const invitation = await invite(i, owner.cookie, org.id, 'recipient@example.com')
    for (const [actor, status, code] of [
      [member, 403, 'TEAM_MANAGEMENT_ACCESS_DENIED'],
      [outsider, 403, 'TEAM_MANAGEMENT_ACCESS_DENIED'],
    ] as const) {
      const response = await post(i.app, 'invite-member', actor.cookie, {
        email: 'other@example.com',
        role: 'member',
        organizationId: org.id,
      })
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ code })
      const canceled = await post(i.app, 'cancel-invitation', actor.cookie, {
        invitationId: invitation.id,
      })
      expect(canceled.status).toBe(actor === member ? 403 : 409)
      expect(await canceled.json()).toMatchObject({
        code:
          actor === member
            ? 'YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION'
            : 'ORGANIZATION_CONTEXT_CHANGED',
      })
      expect(await state(org.id)).toEqual([{ status: 'pending', members: 3 }])
    }
    const canceled = await post(i.app, 'cancel-invitation', admin.cookie, {
      invitationId: invitation.id,
    })
    expect(canceled.status).toBe(200)
    expect(await canceled.json()).toEqual({ ...invitation, status: 'canceled' })
    expect((await invite(i, admin.cookie, org.id, 'other@example.com')).status).toBe('pending')
  })

  it('does not join or accept an invitation when the recipient signs in successfully', async () => {
    const i = instance()
    const owner = await account(i, 'owner@example.com')
    const org = await team(i, owner.cookie)
    const invitation = await invite(i, owner.cookie, org.id, 'new@example.com')
    const requested = await i.app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: invitation.email, callbackURL: '/' }),
    })
    expect(requested.status).toBe(200)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const emailed = outbox.find((message) => message.to === invitation.email)
    const link = new URL(emailed?.text.match(/https?:\/\/\S+/)?.[0] as string)
    const signedIn = await i.app.request((await pressConfirmButton(i.app, link)).toString())
    expect(signedIn.status).toBe(302)
    expect(cookieHeader(signedIn).includes('better-auth.session_token=')).toBe(true)
    expect(await state(org.id)).toEqual([{ status: 'pending', members: 1 }])
    const session = await i.app.request('/api/auth/get-session', {
      headers: { cookie: cookieHeader(signedIn) },
    })
    const body = (await session.json()) as {
      user: { emailVerified: boolean }
      session: { activeOrganizationId: string }
    }
    expect(body.user.emailVerified).toBe(true)
    expect(body.session.activeOrganizationId).not.toBe(org.id)
  })

  it('pins native retry/resend behavior independently of the product admission protocol', async () => {
    const calls: string[] = []
    const i = instance((options) => {
      options.organizationHooks.afterCreateInvitation = async () => void calls.push('created')
      options.sendInvitationEmail = async () => void calls.push('mail')
    }, true)
    const owner = await account(i, 'owner@example.com')
    const org = await team(i, owner.cookie)
    const invitation = await invite(i, owner.cookie, org.id, 'recipient@example.com')
    expect(calls).toEqual(['mail', 'created'])
    const body = { email: 'RECIPIENT@example.com', role: 'member', organizationId: org.id }
    const retried = await post(i.app, 'invite-member', owner.cookie, body)
    expect(retried.status).toBe(400)
    expect(await retried.json()).toMatchObject({
      code: 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION',
    })
    expect(await state(org.id)).toEqual([{ status: 'pending', members: 1 }])
    expect(calls).toEqual(['mail', 'created'])
    await testDb.pool.query(
      `UPDATE auth.invitation SET "expiresAt" = now() + interval '1 hour' WHERE id = $1`,
      [invitation.id],
    )
    const resent = await post(i.app, 'invite-member', owner.cookie, {
      ...body,
      resend: true,
    })
    expect(resent.status).toBe(200)
    const resentInvitation = (await resent.json()) as Invitation
    expect(resentInvitation).toEqual({ ...invitation, expiresAt: expect.any(String) })
    expect(Date.parse(resentInvitation.expiresAt) - Date.now()).toBeGreaterThan(47 * 3_600_000)
    expect(await state(org.id)).toEqual([{ status: 'pending', members: 1 }])
    // Resend bypasses create hooks and does not replace the originally invited role.
    expect(calls).toEqual(['mail', 'created', 'mail'])
  })

  it.each(['beforeCreateInvitation', 'sendInvitationEmail', 'afterCreateInvitation'] as const)(
    'pins the native commit boundary when %s throws independently of product admission',
    async (throwAt) => {
      const calls: { hook: string; rows: Awaited<ReturnType<typeof state>> }[] = []
      const i = instance((options) => {
        for (const hook of [
          'beforeCreateInvitation',
          'sendInvitationEmail',
          'afterCreateInvitation',
        ]) {
          const original = options.organizationHooks[hook]
          const observe = async (input: HookInput) => {
            await original?.(input)
            calls.push({ hook, rows: await state(input.organization.id) })
            if (throwAt === hook) throw new Error('synthetic invitation hook failure')
          }
          if (hook === 'sendInvitationEmail') options.sendInvitationEmail = observe
          else options.organizationHooks[hook] = observe
        }
      }, true)
      const owner = await account(i, 'owner@example.com')
      const org = await team(i, owner.cookie)
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const response = await post(i.app, 'invite-member', owner.cookie, {
          email: 'recipient@example.com',
          role: 'member',
          organizationId: org.id,
        })
        expect(response.status).toBe(throwAt === 'sendInvitationEmail' ? 200 : 500)
      } finally {
        errors.mockRestore()
      }
      expect(calls).toEqual([
        { hook: 'beforeCreateInvitation', rows: [] },
        ...(throwAt === 'beforeCreateInvitation'
          ? []
          : [{ hook: 'sendInvitationEmail', rows: [{ status: 'pending', members: 1 }] }]),
        ...(throwAt !== 'beforeCreateInvitation'
          ? [{ hook: 'afterCreateInvitation', rows: [{ status: 'pending', members: 1 }] }]
          : []),
      ])
      expect(await state(org.id)).toEqual(
        throwAt === 'beforeCreateInvitation' ? [] : [{ status: 'pending', members: 1 }],
      )
      // A delivery/after-hook failure is not self-healing: an ordinary retry is refused.
      if (throwAt !== 'beforeCreateInvitation') {
        const retried = await post(i.app, 'invite-member', owner.cookie, {
          email: 'recipient@example.com',
          role: 'member',
          organizationId: org.id,
        })
        expect(retried.status).toBe(400)
        expect(await retried.json()).toMatchObject({
          code: 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION',
        })
      }
    },
  )
})
