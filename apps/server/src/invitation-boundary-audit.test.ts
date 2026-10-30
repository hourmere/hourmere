import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { pressConfirmButton } from './sign-in-confirm-testing.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4389'
const secret = randomBytes(32).toString('base64')
const policy = { mode: 'closed', allowedDomains: [] } as const

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

async function sourceCopy(before: string, after: string): Promise<typeof createAuth> {
  const location = new URL('../../../packages/auth/src/team-role-policy.ts', import.meta.url)
  const source = readFileSync(location, 'utf8')
  expect(source.includes(before), 'mutation matches its source protection').toBe(true)
  const copy = moduleUrl(source.replace(before, after), location)
  const authLocation = new URL('../../../packages/auth/src/index.ts', import.meta.url)
  return (
    await import(
      moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, {
        './team-role-policy.ts': copy,
      })
    )
  ).createAuth
}

describe.skipIf(!serverUrl)('invitation sign-up and delivery boundary audit', () => {
  let owned: TestDatabase
  let db: Db
  let pool: pg.Pool
  const outbox: MailMessage[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_boundary' })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, policy)
  })
  beforeEach(async () => {
    await owned.pool.query('DELETE FROM auth.organization')
    await owned.pool.query('DELETE FROM auth."user"')
    outbox.length = 0
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
      signup: policy,
      mailer: { send: async (message) => void outbox.push(message) },
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
  type Instance = ReturnType<typeof instance>

  async function session(userId: string, organizationId?: string) {
    const token = randomBytes(24).toString('base64url')
    const stored = await db
      .insertInto('auth.session')
      .values({
        userId,
        token,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: organizationId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      id: stored.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function fixture(i: Instance, email = 'invitee@outside.example') {
    const owner = await db
      .insertInto('auth.user')
      .values({ name: 'Audit owner', email: 'owner@outside.example', emailVerified: true })
      .returning('id')
      .executeTakeFirstOrThrow()
    const team = await db
      .insertInto('auth.organization')
      .values({ name: 'Audit team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.member')
      .values({ userId: owner.id, organizationId: team.id, role: 'owner', createdAt: new Date() })
      .execute()
    const signedIn = await session(owner.id, team.id)
    const response = await i.app.request('/api/auth/organization/invite-member', {
      method: 'POST',
      headers: {
        origin,
        cookie: signedIn.cookie,
        'content-type': 'application/json',
        'x-expected-organization-id': team.id,
      },
      body: JSON.stringify({ organizationId: team.id, email, role: 'member' }),
    })
    expect(response.status).toBe(200)
    const invitation = (await response.json()) as { id: string; email: string }
    return { owner, team, invitation, ownerSession: signedIn }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function recipient(f: Fixture) {
    const user = await db
      .insertInto('auth.user')
      .values({ name: 'Audit recipient', email: f.invitation.email, emailVerified: true })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { user, ...(await session(user.id)) }
  }

  async function memberships(f: Fixture) {
    return db
      .selectFrom('auth.member')
      .select(['userId', 'role'])
      .where('organizationId', '=', f.team.id)
      .where('userId', '!=', f.owner.id)
      .execute()
  }

  async function ask(i: Instance, email: string, invitationId: string) {
    const before = outbox.length
    const response = await i.app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, callbackURL: `/app/join?invitationId=${invitationId}` }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const link = outbox
      .slice(before)
      .at(-1)
      ?.text.match(/https?:\/\/\S+/)?.[0]
    return link ? new URL(link) : undefined
  }

  const read = (i: Instance, f: Fixture, cookie: string) =>
    i.app.request(`/api/auth/organization/get-invitation?id=${f.invitation.id}`, {
      headers: { cookie },
    })
  const accept = (i: Instance, f: Fixture, cookie: string) =>
    i.app.request('/api/auth/organization/accept-invitation', {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ invitationId: f.invitation.id }),
    })

  async function failed(f: Fixture) {
    await db
      .updateTable('invitation_deliveries')
      .set({ state: 'failed', attempts: 1, last_error_code: 'smtp_permanent' })
      .where('invitation_id', '=', f.invitation.id)
      .execute()
  }

  it('normalizes only case and surrounding whitespace, signs in without joining, then requires member authority', async () => {
    const i = instance()
    const f = await fixture(i, '  Invitee@Outside.Example  ')
    expect(f.invitation.email).toBe('invitee@outside.example')
    for (const alias of ['invitee+alias@outside.example', 'in.vitee@outside.example']) {
      expect((await ask(i, alias, f.invitation.id)) !== undefined).toBe(false)
    }
    const link = await ask(i, 'INVITEE@Outside.Example', f.invitation.id)
    expect(link !== undefined).toBe(true)
    const signedIn = await i.app.request((await pressConfirmButton(i.app, link as URL)).toString())
    expect(signedIn.status).toBe(302)
    const cookie = signedIn.headers
      .getSetCookie()
      .map((part) => part.split(';')[0])
      .join('; ')
    expect(cookie.includes('session_token=')).toBe(true)
    expect(await memberships(f), 'sign-in never joins the invited team').toEqual([])
    expect((await read(i, f, cookie)).status).toBe(200)
    expect(await memberships(f), 'loading the accept page details never joins').toEqual([])
    expect((await accept(i, f, cookie)).status).toBe(200)
    expect(await memberships(f)).toEqual([{ userId: expect.any(String), role: 'member' }])
    const invited = await i.app.request('/api/auth/organization/invite-member', {
      method: 'POST',
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        'x-expected-organization-id': f.team.id,
      },
      body: JSON.stringify({ organizationId: f.team.id, email: 'next@outside.example' }),
    })
    expect(invited.status, 'an invited ordinary member cannot invite another address').toBe(403)
    expect(await invited.json()).toMatchObject({ code: 'TEAM_MANAGEMENT_ACCESS_DENIED' })
    await expect(
      i.auth.api.createInvitation({
        body: { organizationId: f.team.id, email: 'next@outside.example', role: 'member' },
        headers: new Headers({ cookie }),
        asResponse: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { code: 'TEAM_MANAGEMENT_ACCESS_DENIED' },
    })
    expect((await ask(i, 'next@outside.example', f.invitation.id)) !== undefined).toBe(false)
  })

  it.each(['canceled', 'expired'] as const)(
    'refuses %s through page lookup, native acceptance, trusted API and sign-up hook',
    async (state) => {
      const i = instance()
      const f = await fixture(i)
      const issued = await ask(i, f.invitation.email, f.invitation.id)
      expect(issued !== undefined).toBe(true)
      await db
        .updateTable('auth.invitation')
        .set(
          state === 'canceled'
            ? { status: 'canceled' }
            : { expiresAt: new Date(Date.now() - 60_000) },
        )
        .where('id', '=', f.invitation.id)
        .execute()
      const signup = await i.app.request(
        (await pressConfirmButton(i.app, issued as URL)).toString(),
      )
      expect(signup.status).toBe(302)
      expect(new URL(signup.headers.get('location') as string).searchParams.get('error')).toBe(
        'SIGNUP_DISABLED',
      )
      expect(await memberships(f)).toEqual([])
      expect(
        await db
          .selectFrom('auth.user')
          .select('id')
          .where('email', '=', f.invitation.email)
          .execute(),
      ).toEqual([])
      const r = await recipient(f)
      expect((await read(i, f, r.cookie)).status).toBe(400)
      expect((await accept(i, f, r.cookie)).status).toBe(400)
      const direct = await i.auth.api.acceptInvitation({
        body: { invitationId: f.invitation.id },
        headers: new Headers({ cookie: r.cookie }),
        asResponse: true,
      })
      expect(direct.status).toBe(400)
      expect(await memberships(f)).toEqual([])
    },
  )

  async function verifyFailed(factory = createAuth, direct = false) {
    const i = instance(factory)
    const f = await fixture(i)
    await failed(f)
    // Registration creates only a personal account; delivery failure cannot auto-join.
    const link = await ask(i, f.invitation.email, f.invitation.id)
    expect(link !== undefined).toBe(true)
    const signedIn = await i.app.request((await pressConfirmButton(i.app, link as URL)).toString())
    expect(signedIn.status).toBe(302)
    const cookie = signedIn.headers
      .getSetCookie()
      .map((part) => part.split(';')[0])
      .join('; ')
    expect(await memberships(f)).toEqual([])
    if (direct) {
      await expect(
        i.auth.api.acceptInvitation({
          body: { invitationId: f.invitation.id },
          headers: new Headers({ cookie }),
          asResponse: true,
        }),
      ).rejects.toMatchObject({ statusCode: 400, body: { code: 'INVITATION_NOT_FOUND' } })
      expect(await memberships(f), 'failed delivery never creates team membership').toEqual([])
      return
    }
    const response = await read(i, f, cookie)
    expect(await memberships(f), 'failed delivery never creates team membership').toEqual([])
    expect(response.status, 'failed invitation delivery is unavailable for joining').toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVITATION_NOT_FOUND' })
    expect((await accept(i, f, cookie)).status).toBe(400)
    expect(await memberships(f), 'failed delivery never creates team membership').toEqual([])
  }

  it('keeps failed mail separate from registration and refuses page/native acceptance', async () => {
    await verifyFailed()
  })

  it('refuses failed mail through trusted native accept API calls', async () => {
    await verifyFailed(createAuth, true)
  })

  it('recovers a failed generation only after an authorized explicit resend', async () => {
    const i = instance()
    const f = await fixture(i)
    const r = await recipient(f)
    await failed(f)
    const earlier = new Date(Date.now() - 120_000)
    await db
      .updateTable('invitation_deliveries')
      .set({ generation_started_at: earlier, updated_at: earlier })
      .where('invitation_id', '=', f.invitation.id)
      .execute()
    expect((await read(i, f, r.cookie)).status).toBe(400)
    const resend = await i.app.request('/api/auth/organization/invite-member', {
      method: 'POST',
      headers: {
        origin,
        cookie: f.ownerSession.cookie,
        'content-type': 'application/json',
        'x-expected-organization-id': f.team.id,
      },
      body: JSON.stringify({
        organizationId: f.team.id,
        email: f.invitation.email,
        resend: true,
        invitationId: f.invitation.id,
        expectedGeneration: 1,
        requestId: randomUUID(),
      }),
    })
    expect(resend.status).toBe(200)
    expect(await resend.json()).toMatchObject({ delivery: { state: 'queued', generation: 2 } })
    expect(await memberships(f)).toEqual([])
    expect((await read(i, f, r.cookie)).status).toBe(200)
    expect((await accept(i, f, r.cookie)).status).toBe(200)
    expect(await memberships(f)).toEqual([{ userId: r.user.id, role: 'member' }])
  })

  it.each(['queued', 'sending', 'smtp_accepted'] as const)(
    'keeps explicit verified acceptance available while delivery is %s',
    async (state) => {
      const i = instance()
      const f = await fixture(i)
      await db
        .updateTable('invitation_deliveries')
        .set({
          state,
          attempts: state === 'queued' ? 0 : 1,
          lease_id: state === 'sending' ? randomUUID() : null,
          lease_until: state === 'sending' ? new Date(Date.now() + 120_000) : null,
          smtp_accepted_at: state === 'smtp_accepted' ? new Date() : null,
        })
        .where('invitation_id', '=', f.invitation.id)
        .execute()
      const r = await recipient(f)
      expect((await read(i, f, r.cookie)).status).toBe(200)
      expect(await memberships(f)).toEqual([])
      expect((await accept(i, f, r.cookie)).status).toBe(200)
      expect(await memberships(f)).toEqual([{ userId: r.user.id, role: 'member' }])
    },
  )

  async function verifyLateFailure(factory = createAuth, direct = false) {
    const i = instance(factory)
    const f = await fixture(i)
    const r = await recipient(f)
    const adapter = (await i.auth.$context).adapter
    const increment = adapter.incrementOne.bind(adapter)
    const spy = vi.spyOn(adapter, 'incrementOne').mockImplementation(async (request) => {
      if (request.model === 'invitation' && request.set?.status === 'accepted') await failed(f)
      return increment(request)
    })
    try {
      const response = direct
        ? await i.auth.api.acceptInvitation({
            body: { invitationId: f.invitation.id },
            headers: new Headers({ cookie: r.cookie }),
            asResponse: true,
          })
        : await accept(i, f, r.cookie)
      expect(
        await memberships(f),
        'a delivery failure committed after preflight never creates a team member',
      ).toEqual([])
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVITATION_NOT_FOUND' })
      expect(
        await db
          .selectFrom('auth.invitation')
          .select('status')
          .where('id', '=', f.invitation.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'pending' })
    } finally {
      spy.mockRestore()
    }
  }

  it.each([false, true])(
    'rechecks failed delivery after preflight (trusted API: %s)',
    async (direct) => {
      await verifyLateFailure(createAuth, direct)
    },
  )

  it('runs an unchanged source copy through the acceptance invariant', async () => {
    const guard = 'await requireJoinableDelivery(trx, invitationId, true)'
    await verifyLateFailure(await sourceCopy(guard, guard), true)
  })

  it('detects removal of the page/preflight delivery refusal in a source copy', async () => {
    const factory = await sourceCopy('await requireJoinableDelivery(db, invitationId)', '')
    await expect(verifyFailed(factory)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining('failed invitation delivery is unavailable for joining'),
    })
  })

  it('detects removal of the locked delivery recheck in a source copy', async () => {
    const factory = await sourceCopy('await requireJoinableDelivery(trx, invitationId, true)', '')
    await expect(verifyLateFailure(factory)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining(
        'a delivery failure committed after preflight never creates a team member',
      ),
    })
  })

  it('detects removal of trusted acceptance context in a source copy', async () => {
    const factory = await sourceCopy(' &&\n        endpoint.path !== accept', '')
    await expect(verifyLateFailure(factory, true)).rejects.toMatchObject({
      name: 'AssertionError',
      message: expect.stringContaining(
        'a delivery failure committed after preflight never creates a team member',
      ),
    })
  })
})
