import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4387'
const secret = randomBytes(32).toString('base64')

function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const javascript = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) => {
      let resolved = replacements[specifier]
      if (!resolved) {
        if (specifier.startsWith('.')) resolved = new URL(specifier, location).href
        else {
          try {
            resolved = import.meta.resolve(specifier)
          } catch {
            resolved = pathToFileURL(createRequire(location).resolve(specifier)).href
          }
        }
      }
      return `from '${resolved}'`
    },
  )
  return `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
}

async function sourceCopy(removeRecipientFence: boolean): Promise<typeof createAuth> {
  const contextLocation = new URL(
    '../../../packages/auth/src/organization-context.ts',
    import.meta.url,
  )
  const source = readFileSync(contextLocation, 'utf8')
  const guard = "if (path === '/organization/accept-invitation') {"
  expect(source.includes(guard), 'mutation matches the recipient acceptance fence').toBe(true)
  const contextUrl = moduleUrl(
    removeRecipientFence ? source.replace(guard, 'if (false) {') : source,
    contextLocation,
  )
  const authLocation = new URL('../../../packages/auth/src/index.ts', import.meta.url)
  const copy = await import(
    moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, {
      './organization-context.ts': contextUrl,
    })
  )
  return copy.createAuth
}

describe.skipIf(!serverUrl)('invitation acceptance transaction and recipient boundaries', () => {
  let owned: TestDatabase
  let db: Db
  let pool: pg.Pool

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_accept' })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, { mode: 'open', allowedDomains: [] })
  })
  beforeEach(async () => {
    await owned.pool.query('DELETE FROM auth.organization')
    await owned.pool.query('DELETE FROM auth."user"')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  function instance(factory = createAuth) {
    const auth = factory({
      pool,
      db,
      baseURL: origin,
      secret,
      signup: { mode: 'open', allowedDomains: [] },
      mailer: { send: async () => {} },
    })
    return {
      auth,
      app: createApp({
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        checkDb: async () => {},
        publicUrl: origin,
      }),
    }
  }

  async function fixture() {
    const recipient = await db
      .insertInto('auth.user')
      .values({
        name: 'Synthetic invitation recipient',
        email: `${randomUUID()}@outside.example`,
        emailVerified: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const inviter = await db
      .insertInto('auth.user')
      .values({
        name: 'Synthetic invitation owner',
        email: `${randomUUID()}@outside.example`,
        emailVerified: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const team = await db
      .insertInto('auth.organization')
      .values({ name: 'Synthetic acceptance team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({
        userId: inviter.id,
        organizationId: team.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    const sessions = []
    for (let index = 0; index < 2; index++) {
      const token = randomBytes(24).toString('base64url')
      const session = await db
        .insertInto('auth.session')
        .values({
          userId: recipient.id,
          token,
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const signature = createHmac('sha256', secret).update(token).digest('base64')
      sessions.push({
        id: session.id,
        cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
      })
    }
    const invitations = await db
      .insertInto('auth.invitation')
      .values(
        Array.from({ length: 2 }, () => ({
          organizationId: team.id,
          inviterId: inviter.id,
          email: recipient.email,
          role: 'member',
          status: 'pending',
          expiresAt: new Date(Date.now() + 3_600_000),
        })),
      )
      .returning('id')
      .execute()
    expect(sessions[0]?.id).not.toBe(sessions[1]?.id)
    expect(invitations[0]?.id).not.toBe(invitations[1]?.id)
    return { recipient, team, sessions, invitations }
  }

  function accept(i: ReturnType<typeof instance>, cookie: string, invitationId: string) {
    return i.app.request('/api/auth/organization/accept-invitation', {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ invitationId }),
    })
  }

  function invitation(i: ReturnType<typeof instance>, cookie: string, invitationId: string) {
    return i.app.request(`/api/auth/organization/get-invitation?id=${invitationId}`, {
      headers: { cookie },
    })
  }

  async function pending(f: Awaited<ReturnType<typeof fixture>>) {
    return db
      .selectFrom('auth.invitation')
      .select('status')
      .where('id', '=', f.invitations[0]?.id as string)
      .executeTakeFirstOrThrow()
  }

  async function memberships(f: Awaited<ReturnType<typeof fixture>>) {
    return db
      .selectFrom('auth.member')
      .select(['id', 'role'])
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.recipient.id)
      .execute()
  }

  it('reads the team for the verified exact recipient without joining or switching on load', async () => {
    const i = instance()
    const f = await fixture()
    const invitationId = f.invitations[0]?.id as string
    await db
      .updateTable('auth.invitation')
      .set({ email: f.recipient.email.toUpperCase() })
      .where('id', '=', invitationId)
      .execute()
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await invitation(i, f.sessions[0]?.cookie as string, invitationId)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        id: invitationId,
        organizationId: f.team.id,
        organizationName: 'Synthetic acceptance team',
        email: f.recipient.email.toUpperCase(),
        status: 'pending',
      })
    }
    expect(await memberships(f), 'reading an invitation never joins the team').toEqual([])
    expect(await pending(f)).toEqual({ status: 'pending' })
    expect(
      await db
        .selectFrom('auth.session')
        .select('activeOrganizationId')
        .where('id', '=', f.sessions[0]?.id as string)
        .executeTakeFirstOrThrow(),
    ).toEqual({ activeOrganizationId: null })
  })

  it('refuses a direct accept from an unverified recipient even with no client email-proof check', async () => {
    const i = instance()
    const f = await fixture()
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.recipient.id)
      .execute()
    const invitationId = f.invitations[0]?.id as string
    const read = await invitation(i, f.sessions[0]?.cookie as string, invitationId)
    expect(read.status).toBe(403)
    expect(await read.json()).toMatchObject({
      code: 'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION',
    })
    // The HTTP request deliberately bypasses the UI's eligibility check.
    const response = await accept(i, f.sessions[0]?.cookie as string, invitationId)
    expect(response.status, 'the server refuses an unverified invitation accept').toBe(403)
    expect(await response.json()).toMatchObject({
      code: 'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION',
    })
    expect(await memberships(f)).toEqual([])
    expect(await pending(f)).toEqual({ status: 'pending' })
  })

  it('refuses a wrong account and does not disclose the recipient address', async () => {
    const i = instance()
    const f = await fixture()
    const invitationId = f.invitations[0]?.id as string
    const invitedEmail = `other-${f.recipient.email}`
    await db
      .updateTable('auth.invitation')
      .set({ email: invitedEmail })
      .where('id', '=', invitationId)
      .execute()
    for (const request of [invitation, accept]) {
      const response = await request(i, f.sessions[0]?.cookie as string, invitationId)
      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body).toMatchObject({ code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION' })
      expect(JSON.stringify(body).includes(invitedEmail)).toBe(false)
    }
    expect(await memberships(f)).toEqual([])
    expect(await pending(f)).toEqual({ status: 'pending' })
  })

  it.each(['expired', 'canceled'] as const)(
    'refuses an %s invitation without membership',
    async (state) => {
      const i = instance()
      const f = await fixture()
      const invitationId = f.invitations[0]?.id as string
      await db
        .updateTable('auth.invitation')
        .set(
          state === 'expired'
            ? { expiresAt: new Date(Date.now() - 60_000) }
            : { status: 'canceled' },
        )
        .where('id', '=', invitationId)
        .execute()
      for (const request of [invitation, accept]) {
        const response = await request(i, f.sessions[0]?.cookie as string, invitationId)
        expect(response.status).toBe(400)
      }
      expect(await memberships(f)).toEqual([])
      expect(await pending(f)).toEqual({ status: state === 'expired' ? 'pending' : 'canceled' })
    },
  )

  it('refuses invalid and nonexistent invitation ids without membership', async () => {
    const i = instance()
    const f = await fixture()
    for (const invitationId of ['not-a-uuid', randomUUID()]) {
      for (const request of [invitation, accept]) {
        const response = await request(i, f.sessions[0]?.cookie as string, invitationId)
        expect(response.status).toBe(400)
      }
    }
    expect(await memberships(f)).toEqual([])
    expect(await pending(f)).toEqual({ status: 'pending' })
  })

  it('keeps an already-member invitation pending and returns the recoverable refusal', async () => {
    const i = instance()
    const f = await fixture()
    await db
      .insertInto('auth.member')
      .values({
        userId: f.recipient.id,
        organizationId: f.team.id,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    const invitationId = f.invitations[0]?.id as string
    const read = await invitation(i, f.sessions[0]?.cookie as string, invitationId)
    expect(read.status).toBe(200)
    const response = await accept(i, f.sessions[0]?.cookie as string, invitationId)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'INVITATION_RECIPIENT_ALREADY_MEMBER' })
    expect(await memberships(f)).toEqual([{ id: expect.any(String), role: 'member' }])
    expect(await pending(f)).toEqual({ status: 'pending' })
  })

  it('accepts explicitly once, activates that team, and refuses repeat accepts without duplicates', async () => {
    const i = instance()
    const f = await fixture()
    const invitationId = f.invitations[0]?.id as string
    const response = await accept(i, f.sessions[0]?.cookie as string, invitationId)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      invitation: { id: invitationId, status: 'accepted' },
      member: { organizationId: f.team.id, userId: f.recipient.id, role: 'member' },
    })
    const repeated = await accept(i, f.sessions[0]?.cookie as string, invitationId)
    expect(repeated.status).toBe(400)
    expect(await repeated.json()).toMatchObject({ code: 'INVITATION_NOT_FOUND' })
    const legacy = await accept(i, f.sessions[1]?.cookie as string, f.invitations[1]?.id as string)
    expect(legacy.status).toBe(409)
    expect(await legacy.json()).toMatchObject({ code: 'INVITATION_RECIPIENT_ALREADY_MEMBER' })
    expect(await memberships(f)).toEqual([{ id: expect.any(String), role: 'member' }])
    expect(await pending(f)).toEqual({ status: 'accepted' })
    expect(
      await db
        .selectFrom('auth.session')
        .select('activeOrganizationId')
        .where('id', '=', f.sessions[0]?.id as string)
        .executeTakeFirstOrThrow(),
    ).toEqual({ activeOrganizationId: f.team.id })
  })

  it('rolls membership and active organization back when the native session update fails', async () => {
    const i = instance()
    const f = await fixture()
    await owned.pool.query(`CREATE FUNCTION public.reject_invitation_context() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic context update failure'; END $$`)
    await owned.pool.query(`CREATE TRIGGER reject_invitation_context
      BEFORE UPDATE OF "activeOrganizationId" ON auth.session
      FOR EACH ROW EXECUTE FUNCTION public.reject_invitation_context()`)
    try {
      const invitationId = f.invitations[0]?.id as string
      const response = await accept(i, f.sessions[0]?.cookie as string, invitationId)
      expect(response.status).toBe(500)
      expect(
        await memberships(f),
        'membership rolls back together with the native active organization update',
      ).toEqual([])
      expect(
        await db
          .selectFrom('auth.invitation')
          .select('status')
          .where('id', '=', invitationId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'pending' })
      expect(
        await db
          .selectFrom('auth.session')
          .select('activeOrganizationId')
          .where('id', '=', f.sessions[0]?.id as string)
          .executeTakeFirstOrThrow(),
      ).toEqual({ activeOrganizationId: null })
    } finally {
      await owned.pool.query('DROP TRIGGER reject_invitation_context ON auth.session')
      await owned.pool.query('DROP FUNCTION public.reject_invitation_context()')
    }
  })

  async function verifyConcurrentAcceptance(factory = createAuth) {
    const i = instance(factory)
    const f = await fixture()
    const adapter = (await i.auth.$context).adapter
    const transaction = adapter.transaction.bind(adapter)
    const release = Promise.withResolvers<void>()
    let waitingInserts = 0
    const spy = vi.spyOn(adapter, 'transaction')
    spy.mockImplementation((callback) =>
      transaction(async (trx) => {
        const create = trx.create.bind(trx)
        trx.create = (async (request: Parameters<typeof create>[0]) => {
          if (
            request.model === 'member' &&
            request.data.organizationId === f.team.id &&
            request.data.userId === f.recipient.id
          ) {
            waitingInserts++
            await release.promise
          }
          return create(request)
        }) as typeof create
        return callback(trx)
      }),
    )
    const requests: Promise<Response>[] = []
    try {
      requests.push(
        Promise.resolve(accept(i, f.sessions[0]?.cookie as string, f.invitations[0]?.id as string)),
      )
      await vi.waitFor(() => expect(waitingInserts).toBe(1), { timeout: 3000, interval: 10 })
      // The first invitation claim committed, while its native member/session transaction
      // waits at the adapter boundary. Distinct invitations share no row-level selector.
      expect(
        await db
          .selectFrom('auth.invitation')
          .select('status')
          .where('id', '=', f.invitations[0]?.id as string)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'accepted' })
      requests.push(
        Promise.resolve(accept(i, f.sessions[1]?.cookie as string, f.invitations[1]?.id as string)),
      )
      await vi.waitFor(
        async () => {
          const locks = await owned.pool.query<{ blocked: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE datname=current_database() AND wait_event_type='Lock'
              AND wait_event='advisory') AS blocked`,
          )
          expect(
            locks.rows[0]?.blocked || waitingInserts === 2,
            'the second session reaches the recipient fence or its unfenced native insert',
          ).toBe(true)
        },
        { timeout: 3000, interval: 10 },
      )
      release.resolve()
      const responses = await Promise.all(requests)
      expect(
        await memberships(f),
        'distinct-session acceptance creates exactly one recipient membership',
      ).toEqual([{ id: expect.any(String), role: 'member' }])
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
      const refused = responses.find((response) => response.status === 409) as Response
      expect(await refused.json()).toMatchObject({ code: 'INVITATION_RECIPIENT_ALREADY_MEMBER' })
      expect(
        (
          await db
            .selectFrom('auth.invitation')
            .select('status')
            .where('organizationId', '=', f.team.id)
            .execute()
        )
          .map((invitation) => invitation.status)
          .sort(),
      ).toEqual(['accepted', 'pending'])
    } finally {
      release.resolve()
      await Promise.allSettled(requests)
      spy.mockRestore()
    }
  }

  it('serializes distinct legacy invitations for one recipient across different sessions', async () => {
    await verifyConcurrentAcceptance()
  })

  it('runs an unchanged source copy through the distinct-session acceptance invariant', async () => {
    await verifyConcurrentAcceptance(await sourceCopy(false))
  })

  it('detects removal of the recipient fence through a duplicate-membership assertion', async () => {
    await expect(verifyConcurrentAcceptance(await sourceCopy(true))).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining(
        'distinct-session acceptance creates exactly one recipient membership',
      ),
    })
  })
})
