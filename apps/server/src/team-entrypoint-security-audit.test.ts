import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { organizationContext } from '../../../packages/auth/src/organization-context.ts'
import {
  ensurePersonalOrganization,
  isMember,
  isUuid,
} from '../../../packages/auth/src/organizations.ts'
import {
  checkTeamManagementAccess,
  TeamManagementError,
  teamSession,
  teamSessionUser,
} from '../../../packages/auth/src/team-management.ts'
import { createApp } from './app.ts'

const { APIError, getSessionFromCtx } = await import(
  pathToFileURL(
    createRequire(new URL('../../../packages/auth/src/index.ts', import.meta.url)).resolve(
      'better-auth/api',
    ),
  ).href
)

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43871'
const secret = 'synthetic-entrypoint-security-audit-secret-0000000000'
const denied = { code: 'TEAM_MANAGEMENT_ACCESS_DENIED', message: 'team_management_access_denied' }
const paths = [
  'cancel-invitation',
  'update-member-role',
  'remove-member',
  'leave',
  'update',
] as const
type Path = (typeof paths)[number]

describe.skipIf(!serverUrl)('native team management security audit', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let pool: ReturnType<typeof createAuthPool>
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'team_entry_audit' })
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    pool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    app = createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
    })
  })

  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function fixture(role: 'owner' | 'admin' | 'member' | 'removed' | 'unverified' = 'owner') {
    const actor = await createTestUser(db, 'Audit actor')
    const owner = await createTestUser(db, 'Continuing owner')
    const peer = await createTestUser(db, 'Audit peer')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: peer, role: 'member' },
      ...(role === 'removed'
        ? []
        : [{ user: actor, role: role === 'unverified' ? 'owner' : role }]),
    ])
    if (role === 'unverified')
      await db
        .updateTable('auth.user')
        .set({ emailVerified: false })
        .where('id', '=', actor.id)
        .execute()
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: actor.id,
        token,
        activeOrganizationId: team.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    const peerMember = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', team.id)
      .where('userId', '=', peer.id)
      .executeTakeFirstOrThrow()
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: team.id,
        inviterId: owner.id,
        email: `${randomUUID()}@example.test`,
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return {
      actor,
      owner,
      team,
      peerMember,
      invitation,
      sessionId: session.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function application(selectedAuth: Auth) {
    return selectedAuth === auth
      ? app
      : createApp({
          authHandler: selectedAuth.handler,
          resolveCaller: createCallerResolver({ auth: selectedAuth, db }),
          checkDb: async () => {},
          publicUrl: origin,
        })
  }

  function body(f: Fixture, path: Path) {
    if (path === 'cancel-invitation') return { invitationId: f.invitation.id }
    if (path === 'update-member-role')
      return { organizationId: f.team.id, memberId: f.peerMember.id, role: 'admin' }
    if (path === 'remove-member')
      return { organizationId: f.team.id, memberIdOrEmail: f.peerMember.id }
    if (path === 'leave') return { organizationId: f.team.id }
    return { organizationId: f.team.id, data: { name: 'Unwanted update' } }
  }

  function request(
    f: Fixture,
    path: Path,
    expected?: string,
    source: string | null = origin,
    selected = app,
  ) {
    return selected.request(`/api/auth/organization/${path}`, {
      method: 'POST',
      headers: {
        cookie: f.cookie,
        'content-type': 'application/json',
        ...(source === null ? {} : { origin: source }),
        ...(expected === undefined ? {} : { 'x-expected-organization-id': expected }),
      },
      body: JSON.stringify(body(f, path)),
    })
  }

  async function unchanged(f: Fixture) {
    expect(
      await db
        .selectFrom('auth.organization')
        .select('name')
        .where('id', '=', f.team.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ name: 'Test Team' })
    expect(
      await db
        .selectFrom('auth.member')
        .select('role')
        .where('id', '=', f.peerMember.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ role: 'member' })
    expect(
      await db
        .selectFrom('auth.invitation')
        .select('status')
        .where('id', '=', f.invitation.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'pending' })
  }

  it.each(paths)(
    '%s checks revoked and unverified authority before missing-context recovery',
    async (path) => {
      const roles: Parameters<typeof fixture>[0][] = ['removed', 'unverified']
      if (path !== 'leave') roles.push('member')
      for (const role of roles) {
        const f = await fixture(role)
        const response = await request(f, path)
        expect(response.status, `${path}: ${role}`).toBe(403)
        expect(await response.json()).toEqual(denied)
        await unchanged(f)
      }
    },
  )

  it.each(['update', 'cancel-invitation'] as const)(
    '%s refuses an unverified legacy owner with matching context',
    async (path) => {
      const f = await fixture('unverified')
      const response = await request(f, path, f.team.id)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
      await unchanged(f)
    },
  )

  it.each(paths)('%s keeps missing-context recovery for an authorized caller', async (path) => {
    const f = await fixture()
    const response = await request(f, path)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'ORGANIZATION_CONTEXT_CHANGED' })
    await unchanged(f)
  })

  it('denies malformed expected context before inspecting an authorized but stale body team', async () => {
    const f = await fixture()
    const other = await createTestTeam(db, [{ user: f.actor, role: 'owner' }])
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: other.id })
      .where('id', '=', f.sessionId)
      .execute()
    const response = await request(f, 'update', 'malformed')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(denied)
    await unchanged(f)
  })

  it.each(paths)('%s uses the same denial without a session', async (path) => {
    const f = await fixture()
    const response = await app.request(`/api/auth/organization/${path}`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-expected-organization-id': f.team.id,
      },
      body: JSON.stringify(body(f, path)),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(denied)
    await unchanged(f)
  })

  it.each([
    '',
    'add-member',
    'create-role',
    'delete-role',
    'list-roles',
    'get-role',
    'update-role',
    'create-team',
    'remove-team',
    'update-team',
    'list-teams',
    'set-active-team',
    'list-user-teams',
    'list-team-members',
    'add-team-member',
    'remove-team-member',
  ])('does not expose disabled or pathless organization endpoint %s', async (path) => {
    const f = await fixture()
    for (const method of ['GET', 'POST']) {
      const response = await app.request(`/api/auth/organization/${path}`, {
        method,
        headers: { cookie: f.cookie, origin, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      })
      expect(response.status).toBe(404)
    }
    await unchanged(f)
  })

  it.each(['create', 'set-active'] as const)(
    '%s requires a verified live session',
    async (path) => {
      const f = await fixture('unverified')
      const response = await app.request(`/api/auth/organization/${path}`, {
        method: 'POST',
        headers: { cookie: f.cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(
          path === 'create'
            ? { name: 'Unverified team', slug: randomUUID() }
            : { organizationId: f.team.id },
        ),
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
      await unchanged(f)
    },
  )

  async function verifyContextPersistence(path: 'create' | 'set-active', selectedAuth = auth) {
    const f = await fixture()
    const target = await createTestTeam(db, [{ user: f.actor, role: 'member' }])
    const selected = application(selectedAuth)
    const adapter = (await selectedAuth.$context).adapter
    const method = path === 'create' ? 'create' : 'update'
    const original = adapter[method].bind(adapter)
    const spy = vi.spyOn(adapter, method)
    let entered = false
    spy.mockImplementation((async (input: Parameters<typeof original>[0]) => {
      if (
        !entered &&
        (path === 'create'
          ? input.model === 'organization'
          : input.model === 'session' &&
            'update' in input &&
            input.update.activeOrganizationId === target.id)
      ) {
        entered = true
        if (path === 'create')
          await db
            .updateTable('auth.user')
            .set({ emailVerified: false })
            .where('id', '=', f.actor.id)
            .execute()
        else
          await db
            .deleteFrom('auth.member')
            .where('organizationId', '=', target.id)
            .where('userId', '=', f.actor.id)
            .execute()
      }
      return path === 'create'
        ? (original as typeof adapter.create)(input as Parameters<typeof adapter.create>[0])
        : (original as typeof adapter.update)(input as Parameters<typeof adapter.update>[0])
    }) as typeof original)
    const slug = randomUUID()
    try {
      const response = await selected.request(`/api/auth/organization/${path}`, {
        method: 'POST',
        headers: { cookie: f.cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(
          path === 'create' ? { name: 'Racing creation', slug } : { organizationId: target.id },
        ),
      })
      expect(entered).toBe(true)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
      expect(
        await db.selectFrom('auth.organization').select('id').where('slug', '=', slug).execute(),
      ).toEqual([])
      expect(
        await db
          .selectFrom('auth.session')
          .select('activeOrganizationId')
          .where('id', '=', f.sessionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ activeOrganizationId: f.team.id })
    } finally {
      spy.mockRestore()
    }
  }

  it.each(['create', 'set-active'] as const)(
    '%s rechecks identity or target membership at persistence',
    async (path) => {
      await verifyContextPersistence(path)
    },
  )

  it.each(['null', 'removed'] as const)(
    'keeps valid bound switching from %s personal fallback',
    async (mode) => {
      const f = await fixture()
      const target = await createTestTeam(db, [{ user: f.actor, role: 'member' }])
      if (mode === 'null')
        await db
          .updateTable('auth.session')
          .set({ activeOrganizationId: null })
          .where('id', '=', f.sessionId)
          .execute()
      else
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', f.team.id)
          .where('userId', '=', f.actor.id)
          .execute()
      const response = await app.request('/api/auth/organization/set-active', {
        method: 'POST',
        headers: {
          cookie: f.cookie,
          origin,
          'content-type': 'application/json',
          'x-expected-organization-id': f.actor.principal.organization.id,
        },
        body: JSON.stringify({ organizationId: target.id }),
      })
      expect(response.status).toBe(200)
      expect(
        await db
          .selectFrom('auth.session')
          .select('activeOrganizationId')
          .where('id', '=', f.sessionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ activeOrganizationId: target.id })
    },
  )

  async function verifyRevocation(path: 'update' | 'cancel-invitation', selectedAuth = auth) {
    const f = await fixture()
    const selected = application(selectedAuth)
    const adapter = (await selectedAuth.$context).adapter
    const method = path === 'update' ? 'update' : 'incrementOne'
    const original = adapter[method].bind(adapter)
    const spy = vi.spyOn(adapter, method)
    let entered = false
    spy.mockImplementation((async (input: Parameters<typeof original>[0]) => {
      if (!entered && input.model === (path === 'update' ? 'organization' : 'invitation')) {
        entered = true
        await db
          .updateTable('auth.member')
          .set({ role: 'member' })
          .where('organizationId', '=', f.team.id)
          .where('userId', '=', f.actor.id)
          .execute()
      }
      return original(input as never)
    }) as typeof original)
    try {
      const response = await request(f, path, f.team.id, origin, selected)
      expect(entered).toBe(true)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
      await unchanged(f)
    } finally {
      spy.mockRestore()
    }
  }

  it.each(['update', 'cancel-invitation'] as const)(
    '%s rechecks revocation at the actual write',
    async (path) => {
      await verifyRevocation(path)
    },
  )

  async function verifyTerminal(
    state: 'accepted' | 'rejected' | 'expired' | 'canceled',
    selectedAuth = auth,
  ) {
    const f = await fixture()
    const status = state === 'expired' ? 'pending' : state
    await db
      .updateTable('auth.invitation')
      .set({ status, ...(state === 'expired' ? { expiresAt: new Date(Date.now() - 60_000) } : {}) })
      .where('id', '=', f.invitation.id)
      .execute()
    const response = await request(
      f,
      'cancel-invitation',
      f.team.id,
      origin,
      application(selectedAuth),
    )
    expect(response.status).toBe(state === 'canceled' ? 200 : 409)
    if (state !== 'canceled')
      expect(await response.json()).toMatchObject({ code: 'INVITATION_INELIGIBLE' })
    expect(
      await db
        .selectFrom('auth.invitation')
        .select('status')
        .where('id', '=', f.invitation.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status })
  }

  async function verifyRejection(terminal: 'accepted' | 'canceled', selectedAuth = auth) {
    const f = await fixture('removed')
    await db
      .updateTable('auth.invitation')
      .set({ email: f.actor.email })
      .where('id', '=', f.invitation.id)
      .execute()
    const selected = application(selectedAuth)
    const adapter = (await selectedAuth.$context).adapter
    const original = adapter.incrementOne.bind(adapter)
    const spy = vi.spyOn(adapter, 'incrementOne')
    let transitioned = false
    spy.mockImplementation((async (input: Parameters<typeof original>[0]) => {
      if (!transitioned && input.model === 'invitation' && input.set?.status === 'rejected') {
        transitioned = true
        let cookie = f.cookie
        if (terminal === 'canceled') {
          const token = randomBytes(24).toString('base64url')
          await db
            .insertInto('auth.session')
            .values({
              userId: f.owner.id,
              token,
              activeOrganizationId: f.team.id,
              expiresAt: new Date(Date.now() + 3_600_000),
              updatedAt: new Date(),
            })
            .execute()
          const signature = createHmac('sha256', secret).update(token).digest('base64')
          cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
        }
        const response = await selected.request(
          `/api/auth/organization/${terminal === 'accepted' ? 'accept' : 'cancel'}-invitation`,
          {
            method: 'POST',
            headers: {
              cookie,
              origin,
              'content-type': 'application/json',
              'x-expected-organization-id': f.team.id,
            },
            body: JSON.stringify({ invitationId: f.invitation.id }),
          },
        )
        expect(response.status).toBe(200)
      }
      return original(input)
    }) as typeof original)
    try {
      const response = await selected.request('/api/auth/organization/reject-invitation', {
        method: 'POST',
        headers: { cookie: f.cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ invitationId: f.invitation.id }),
      })
      expect(transitioned).toBe(true)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'INVITATION_INELIGIBLE' })
      expect(
        await db
          .selectFrom('auth.invitation')
          .select('status')
          .where('id', '=', f.invitation.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: terminal })
      const member = await db
        .selectFrom('auth.member')
        .select('id')
        .where('userId', '=', f.actor.id)
        .where('organizationId', '=', f.team.id)
        .executeTakeFirst()
      expect(Boolean(member)).toBe(terminal === 'accepted')
    } finally {
      spy.mockRestore()
    }
  }

  it.each(['accepted', 'canceled'] as const)(
    'a stale rejection preserves the concurrently %s invitation',
    async (terminal) => {
      await verifyRejection(terminal)
    },
  )

  it.each(['accepted', 'rejected', 'expired', 'canceled'] as const)(
    'does not rewrite %s invitation history during cancellation',
    async (state) => {
      await verifyTerminal(state)
    },
  )

  it.each(paths)('%s refuses foreign, opaque and absent origins before a write', async (path) => {
    const f = await fixture()
    for (const source of ['https://foreign.example', 'null', null]) {
      const response = await request(f, path, f.team.id, source)
      expect(response.status, `${path}: ${source}`).toBe(403)
      await unchanged(f)
    }
  })

  function sourceCopy(mutation?: 'authority' | 'identity' | 'session'): typeof organizationContext {
    let source = readFileSync('packages/auth/src/organization-context.ts', 'utf8')
    const start =
      '  // Authorize before revealing context recovery, including legacy unverified sessions.\n'
    const end = '  if (expected === null) throw changed()\n'
    expect(source.includes(start), 'authority mutation anchor').toBe(true)
    if (mutation === 'authority')
      source = source.slice(0, source.indexOf(start)) + source.slice(source.indexOf(end))
    if (mutation === 'identity') {
      const before =
        "if (ctx.path === '/organization/create' || ctx.path === '/organization/set-active') {"
      expect(source.includes(before), 'identity mutation anchor').toBe(true)
      source = source.replace(before, 'if (false) {')
    }
    if (mutation === 'session') {
      const start = '  if (!session) {\n    if (boundSwitch) return\n'
      const end = '  const body = ctx.body as Record<string, unknown> | undefined\n'
      expect(source.includes(start), 'session mutation anchor').toBe(true)
      source =
        source.slice(0, source.indexOf(start)) +
        '  if (!session) return\n' +
        source.slice(source.indexOf(end))
    }
    const javascript = stripTypeScriptTypes(
      source.replace(/^import[\s\S]*?from '[^']+'\n/gm, ''),
    ).replace(/\bexport /g, '')
    const bindings = {
      APIError,
      getSessionFromCtx,
      ensurePersonalOrganization,
      isMember,
      isUuid,
      checkTeamManagementAccess,
      TeamManagementError,
      teamSession,
      teamSessionUser,
    }
    return new Function(...Object.keys(bindings), `${javascript}; return organizationContext`)(
      ...Object.values(bindings),
    ) as typeof organizationContext
  }

  async function verifyAuthority(
    check: typeof organizationContext,
    kind:
      | 'authority'
      | 'missing context'
      | 'identity'
      | 'switch identity'
      | 'session' = 'authority',
  ) {
    const f = await fixture('unverified')
    const session =
      kind === 'session'
        ? null
        : await auth.api.getSession({ headers: new Headers({ cookie: f.cookie }) })
    if (kind !== 'session') expect(session).not.toBeNull()
    const ctx = {
      path:
        kind === 'identity'
          ? '/organization/create'
          : kind === 'switch identity'
            ? '/organization/set-active'
            : '/organization/update',
      body: body(f, 'update'),
      request: new Request(origin, {
        headers: kind === 'missing context' ? {} : { 'x-expected-organization-id': f.team.id },
      }),
      context: { session },
    } as unknown as Parameters<typeof organizationContext>[0]
    await expect(check(ctx, db)).rejects.toMatchObject({ status: 'FORBIDDEN', body: denied })
  }

  it('passes the real database authority assertions with the original source copy', async () => {
    for (const kind of [
      'authority',
      'missing context',
      'identity',
      'switch identity',
      'session',
    ] as const)
      await verifyAuthority(sourceCopy(), kind)
  })

  it.each(['authority', 'missing context', 'identity', 'switch identity', 'session'] as const)(
    'detects removal of the native %s check through a real assertion failure',
    async (kind) => {
      const mutation =
        kind === 'missing context' ? 'authority' : kind === 'switch identity' ? 'identity' : kind
      await expect(verifyAuthority(sourceCopy(mutation), kind)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )

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

  async function policyCopy(before?: string, after = '') {
    const location = new URL('../../../packages/auth/src/team-role-policy.ts', import.meta.url)
    let source = readFileSync(location, 'utf8')
    if (before) {
      expect(source.includes(before), 'policy mutation anchor').toBe(true)
      source = source.replaceAll(before, after)
    }
    const copy = moduleUrl(source, location)
    const authLocation = new URL('../../../packages/auth/src/index.ts', import.meta.url)
    const { createAuth: copiedCreateAuth } = (await import(
      moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, {
        './team-role-policy.ts': copy,
      })
    )) as { createAuth: typeof createAuth }
    return copiedCreateAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup: { mode: 'open', allowedDomains: [] },
      mailer: { send: async () => {} },
    })
  }

  it('passes write-boundary and invitation lifecycle assertions with an original source copy', async () => {
    const copy = await policyCopy()
    for (const path of ['update', 'cancel-invitation'] as const) await verifyRevocation(path, copy)
    for (const state of ['accepted', 'rejected', 'expired'] as const)
      await verifyTerminal(state, copy)
    for (const terminal of ['accepted', 'canceled'] as const) await verifyRejection(terminal, copy)
    for (const path of ['create', 'set-active'] as const) await verifyContextPersistence(path, copy)
  })

  it.each(['update', 'cancel-invitation'] as const)(
    'detects removal of the %s transaction guard through a real HTTP assertion',
    async (path) => {
      const branch =
        path === 'update'
          ? "if (ctx?.path === updateOrganization && request.model === 'organization') {"
          : "if (ctx?.path === cancelInvitation && request.model === 'invitation') {"
      await expect(
        verifyRevocation(path, await policyCopy(branch, 'if (false) {')),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  it.each(['accepted', 'expired'] as const)(
    'detects removal of the %s lifecycle guard through a real HTTP assertion',
    async (state) => {
      const branch = "if (invitation.status !== 'pending' || invitation.expiresAt <= clock.now) {"
      await expect(
        verifyTerminal(state, await policyCopy(branch, 'if (false) {')),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  it.each(['accepted', 'canceled'] as const)(
    'detects stale rejection overwriting %s through a real HTTP assertion',
    async (terminal) => {
      const branch = "if (ctx?.path === rejectInvitation && request.model === 'invitation') {"
      await expect(
        verifyRejection(terminal, await policyCopy(branch, 'if (false) {')),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  it.each(['create', 'set-active'] as const)(
    'detects removal of %s persistence protection through a real HTTP assertion',
    async (path) => {
      const branch =
        path === 'create' ? 'ctx.path === createOrganization' : 'ctx.path === setActiveOrganization'
      await expect(
        verifyContextPersistence(path, await policyCopy(branch, 'false')),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
})
