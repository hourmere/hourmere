import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createAuth, createAuthPool, createCallerResolver, maySignUp } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { leaveTeamMember } from '@hourmere/scheduling'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { pressConfirmButton } from './sign-in-confirm-testing.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4392'
const secret = randomBytes(32).toString('base64')
const policy = { mode: 'closed', allowedDomains: ['trusted.example'] } as const
const recipient = 'recipient@outside.example'

async function signupSourceCopy(
  mutation?: 'membership' | 'organization' | 'inviter',
): Promise<typeof maySignUp> {
  const location = new URL('../../../packages/auth/src/signup.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  const guard = `.where((eb) =>
      eb.exists(
        eb
          .selectFrom('auth.member as inviterMembership')
          .select('inviterMembership.id')
          .whereRef('inviterMembership.organizationId', '=', 'auth.invitation.organizationId')
          .whereRef('inviterMembership.userId', '=', 'auth.invitation.inviterId'),
      ),
    )`
  expect(source.includes(guard), 'source-copy mutation matches the membership protection').toBe(
    true,
  )
  if (mutation === 'membership') source = source.replace(guard, '')
  if (mutation === 'organization')
    source = source.replace(
      ".whereRef('inviterMembership.organizationId', '=', 'auth.invitation.organizationId')",
      '',
    )
  if (mutation === 'inviter')
    source = source.replace(
      ".whereRef('inviterMembership.userId', '=', 'auth.invitation.inviterId')",
      '',
    )
  const javascript = stripTypeScriptTypes(source).replace(
    "from 'kysely'",
    `from '${import.meta.resolve('kysely')}'`,
  )
  return (await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`))
    .maySignUp
}

describe.skipIf(!serverUrl)('void invitations do not admit account registration', () => {
  let owned: TestDatabase
  let db: Db
  let pool: pg.Pool
  const sent: MailMessage[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'inviter_signup' })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, policy)
  })
  beforeEach(async () => {
    await owned.pool.query('DELETE FROM auth.organization')
    await owned.pool.query('DELETE FROM auth."user"')
    sent.length = 0
  })
  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  function instance() {
    const auth = createAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup: policy,
      mailer: { send: async (message) => void sent.push(message) },
      leaveTeamMember: (principal, teamId, expectedOrganizationId) =>
        leaveTeamMember(
          { db, principal, now: () => Temporal.Now.instant() },
          { teamId, expectedOrganizationId },
        ),
    })
    return createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
    })
  }
  type App = ReturnType<typeof instance>

  async function fixture() {
    const team = await db
      .insertInto('auth.organization')
      .values({ name: 'Synthetic signup team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    const accounts = []
    // The inviter has domain-based signup authority, independently of the first-user rule.
    for (const [email, role] of [
      ['first@outside.example', 'owner'],
      ['inviter@trusted.example', 'admin'],
    ] as const) {
      const user = await db
        .insertInto('auth.user')
        .values({ name: 'Synthetic signup account', email, emailVerified: true })
        .returningAll()
        .executeTakeFirstOrThrow()
      const member = await db
        .insertInto('auth.member')
        .values({ userId: user.id, organizationId: team.id, role, createdAt: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow()
      const token = randomBytes(24).toString('base64url')
      await db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token,
          activeOrganizationId: team.id,
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
        })
        .execute()
      const signature = createHmac('sha256', secret).update(token).digest('base64')
      accounts.push({
        ...user,
        memberId: member.id,
        cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
      })
    }
    const [owner, inviter] = accounts as [(typeof accounts)[number], (typeof accounts)[number]]
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: team.id,
        inviterId: inviter.id,
        email: recipient,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { team, owner, inviter, invitation }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function depart(app: App, f: Fixture, departure: 'left' | 'removed') {
    return app.request(
      `/api/auth/organization/${departure === 'left' ? 'leave' : 'remove-member'}`,
      {
        method: 'POST',
        headers: {
          origin,
          cookie: departure === 'left' ? f.inviter.cookie : f.owner.cookie,
          'content-type': 'application/json',
          'x-expected-organization-id': f.team.id,
        },
        body: JSON.stringify({
          organizationId: f.team.id,
          ...(departure === 'removed' && { memberIdOrEmail: f.inviter.memberId }),
        }),
      },
    )
  }

  async function ask(app: App) {
    const before = sent.length
    const response = await app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: recipient, callbackURL: '/app' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const url = sent.slice(before)[0]?.text.match(/https?:\/\/\S+/)?.[0]
    return url ? new URL(url) : undefined
  }

  const recipientRows = () =>
    db.selectFrom('auth.user').select('id').where('email', '=', recipient).execute()

  async function assertVoidEligibility(check: typeof maySignUp) {
    expect(await check(db, policy, recipient), 'a void invitation cannot grant signup').toBe(false)
  }

  it.each(['left', 'removed'] as const)(
    'sends no new link and refuses an already issued link after the inviter %s',
    async (departure) => {
      const f = await fixture()
      const app = instance()
      const earlier = await ask(app)
      expect(earlier !== undefined).toBe(true)
      expect((await depart(app, f, departure)).status).toBe(200)
      await assertVoidEligibility(maySignUp)
      expect((await ask(app)) === undefined, 'no sign-in link for a void invitation').toBe(true)
      const response = await app.request((await pressConfirmButton(app, earlier as URL)).toString())
      expect(response.status).toBe(302)
      expect(new URL(response.headers.get('location') as string).searchParams.get('error')).toBe(
        'SIGNUP_DISABLED',
      )
      expect(
        response.headers.getSetCookie().some((cookie) => cookie.includes('session_token=')),
      ).toBe(false)
      expect(await recipientRows(), 'no account was admitted by the void invitation').toEqual([])
      expect(
        await db
          .selectFrom('auth.invitation')
          .selectAll()
          .where('id', '=', f.invitation.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(f.invitation)
    },
  )

  it.each(['admin', 'member'] as const)(
    'keeps signup unchanged while the original inviter remains a %s',
    async (role) => {
      const f = await fixture()
      await db
        .updateTable('auth.member')
        .set({ role })
        .where('id', '=', f.inviter.memberId)
        .execute()
      const app = instance()
      const link = await ask(app)
      expect(link !== undefined).toBe(true)
      const response = await app.request((await pressConfirmButton(app, link as URL)).toString())
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`${origin}/app`)
      expect(await recipientRows()).toHaveLength(1)
      expect(
        await db
          .selectFrom('auth.member')
          .select('id')
          .where('organizationId', '=', f.team.id)
          .execute(),
        'signup remains separate from accepting the invitation',
      ).toHaveLength(2)
    },
  )

  it('requires membership in the invitation team rather than another team', async () => {
    const f = await fixture()
    expect((await depart(instance(), f, 'removed')).status).toBe(200)
    const other = await db
      .insertInto('auth.organization')
      .values({ name: 'Other synthetic team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({
        userId: f.inviter.id,
        organizationId: other.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    await assertVoidEligibility(maySignUp)
    expect((await ask(instance())) === undefined).toBe(true)
    expect(await recipientRows()).toEqual([])
  })

  async function blockedBy(blocker: number, message: string) {
    let pids: number[] = []
    await vi.waitFor(
      async () => {
        const result = await owned.pool.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
           AND $1 = ANY(pg_blocking_pids(pid))`,
          [blocker],
        )
        pids = result.rows.map((row) => row.pid)
        expect(pids.length, message).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 10 },
    )
    return pids
  }

  it('waits for an earlier inviter removal, then refuses signup at the database backstop', async () => {
    const f = await fixture()
    const fence = `hourmere.inviter-signup-test:${randomUUID()}`
    const holder = await owned.pool.connect()
    const signingUp = await pool.connect()
    let removal: Promise<Response> | undefined
    let insertion: Promise<{ code?: string }> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [fence])
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid as number
      await owned.pool.query(`CREATE FUNCTION public.pause_signup_inviter_removal() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${fence}', 0)); RETURN OLD; END $$`)
      await owned.pool.query(`CREATE TRIGGER pause_signup_inviter_removal BEFORE DELETE ON auth.member
        FOR EACH ROW WHEN (OLD."userId" = '${f.inviter.id}'::uuid)
        EXECUTE FUNCTION public.pause_signup_inviter_removal()`)
      removal = Promise.resolve(depart(instance(), f, 'removed'))
      const removing = await blockedBy(holderPid, 'removal has locked its member before deletion')
      insertion = signingUp
        .query(
          `INSERT INTO auth."user" (name,email,"emailVerified") VALUES ('Synthetic', $1, true)`,
          [recipient],
        )
        .then(
          () => ({}),
          (error: { code?: string }) => ({ code: error.code }),
        )
      await blockedBy(removing[0] as number, 'signup waits for the inviter member row removal')
      await holder.query('ROLLBACK')
      expect((await removal).status).toBe(200)
      expect(await insertion).toEqual({ code: '42501' })
      expect(await recipientRows()).toEqual([])
    } finally {
      await holder.query('ROLLBACK')
      await Promise.allSettled([removal, insertion])
      holder.release()
      signingUp.release()
      await owned.pool.query('DROP TRIGGER IF EXISTS pause_signup_inviter_removal ON auth.member')
      await owned.pool.query('DROP FUNCTION IF EXISTS public.pause_signup_inviter_removal()')
    }
  })

  it('holds the inviter member row until an earlier signup commits, then permits removal', async () => {
    const f = await fixture()
    const signingUp = await pool.connect()
    let removal: Promise<Response> | undefined
    try {
      await signingUp.query('BEGIN')
      await signingUp.query(
        `INSERT INTO auth."user" (name,email,"emailVerified") VALUES ('Synthetic', $1, true)`,
        [recipient],
      )
      const signerPid = (await signingUp.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid as number
      removal = Promise.resolve(depart(instance(), f, 'removed'))
      await blockedBy(signerPid, 'removal waits for the signup member share lock')
      expect(await recipientRows(), 'the earlier signup has not committed').toEqual([])
      await signingUp.query('COMMIT')
      expect((await removal).status).toBe(200)
      expect(await recipientRows()).toHaveLength(1)
      expect(
        await db
          .selectFrom('auth.member')
          .select('id')
          .where('id', '=', f.inviter.memberId)
          .execute(),
      ).toEqual([])
    } finally {
      await signingUp.query('ROLLBACK')
      await removal
      signingUp.release()
    }
  })

  it.each(['membership', 'organization', 'inviter'] as const)(
    'detects removal of the app %s protection with a real database assertion',
    async (mutation) => {
      const f = await fixture()
      expect((await depart(instance(), f, 'removed')).status).toBe(200)
      if (mutation === 'organization') {
        const other = await db
          .insertInto('auth.organization')
          .values({ name: 'Other mutation team', slug: randomUUID(), createdAt: new Date() })
          .returning('id')
          .executeTakeFirstOrThrow()
        await db
          .insertInto('auth.member')
          .values({
            userId: f.inviter.id,
            organizationId: other.id,
            role: 'owner',
            createdAt: new Date(),
          })
          .execute()
      }
      const intact = await signupSourceCopy()
      await assertVoidEligibility(intact)
      await expect(assertVoidEligibility(await signupSourceCopy(mutation))).rejects.toThrow(
        'a void invitation cannot grant signup',
      )
      await assertVoidEligibility(intact)
    },
  )
})
