import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createRoute, z } from '@hono/zod-openapi'
import {
  type Auth,
  cancelTeamInvitation,
  createAuth,
  createAuthPool,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DomainError } from '@hourmere/scheduling'
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
import { ErrorBody, json } from './openapi.ts'
import { teamInvitationRoutes } from './routes/team-invitations.ts'
import { listTeamInvitationSummaries, TeamInvitationSummarySchema } from './team-invitations.ts'
import { teamManagementAccess } from './team-management.ts'

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
      routes: [teamInvitationRoutes({ db, invitationMailLimits: { secret } })],
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

  it.each(paths)(
    '%s uniformly denies authenticated callers without authority with matching context',
    async (path) => {
      for (const role of ['removed', 'unverified'] as const) {
        const f = await fixture(role)
        const response = await request(f, path, f.team.id)
        expect(response.status, `${path}: ${role}`).toBe(403)
        expect(await response.json()).toEqual(denied)
        await unchanged(f)
      }
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

  async function verifyUnauthenticated(path: Path, selectedAuth = auth) {
    const f = await fixture()
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where('id', '=', f.sessionId)
      .execute()
    for (const cookie of [undefined, f.cookie]) {
      for (const expected of [undefined, f.team.id, 'malformed']) {
        const response = await application(selectedAuth).request(`/api/auth/organization/${path}`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            ...(cookie === undefined ? {} : { cookie }),
            ...(expected === undefined ? {} : { 'x-expected-organization-id': expected }),
          },
          body: JSON.stringify(body(f, path)),
        })
        // The existing cancellation hook owns its uniform denial; other native endpoints
        // retain Better Auth's authentication response when there is no session.
        expect(response.status, `${path}: ${cookie ? 'expired' : 'absent'} session`).toBe(
          path === 'cancel-invitation' ? 403 : 401,
        )
        expect(await response.json()).toEqual(
          path === 'cancel-invitation'
            ? denied
            : path === 'update'
              ? { message: 'User not found' }
              : { code: 'UNAUTHORIZED', message: 'Unauthorized' },
        )
      }
    }
    await unchanged(f)
  }

  it.each(paths)(
    '%s preserves its native authentication response for absent and expired sessions',
    async (path) => {
      await verifyUnauthenticated(path)
    },
  )

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
    let entered = false
    const revoke = async () => {
      if (!entered) {
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
    }
    const transaction = adapter.transaction.bind(adapter)
    const update = adapter.update.bind(adapter)
    const spy =
      path === 'create'
        ? vi.spyOn(adapter, 'transaction').mockImplementation((callback) =>
            transaction(async (trx) => {
              // Native creation inserts through its transaction adapter. Revoke on the
              // independent connection before the policy takes its locked write snapshot.
              const create = trx.create.bind(trx)
              trx.create = async (input) => {
                if (input.model === 'organization') await revoke()
                return create(input)
              }
              return callback(trx)
            }),
          )
        : vi.spyOn(adapter, 'update').mockImplementation((async (
            input: Parameters<typeof update>[0],
          ) => {
            if (input.model === 'session' && input.update.activeOrganizationId === target.id)
              await revoke()
            return update(input)
          }) as typeof update)
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
    let entered = false
    const demote = async () => {
      if (!entered) {
        entered = true
        await db
          .updateTable('auth.member')
          .set({ role: 'member' })
          .where('organizationId', '=', f.team.id)
          .where('userId', '=', f.actor.id)
          .execute()
      }
    }
    const original = adapter.update.bind(adapter)
    const transaction = db.transaction.bind(db)
    function transactionBoundary(
      builder: ReturnType<typeof transaction>,
    ): ReturnType<typeof transaction> {
      return new Proxy(builder, {
        get(target, property, receiver) {
          if (property === 'setIsolationLevel')
            return (level: Parameters<typeof builder.setIsolationLevel>[0]) =>
              transactionBoundary(target.setIsolationLevel(level))
          if (property === 'execute')
            return async (operation: Parameters<typeof builder.execute>[0]) => {
              await demote()
              return target.execute(operation)
            }
          return Reflect.get(target, property, receiver)
        },
      })
    }
    const spy =
      path === 'cancel-invitation'
        ? vi.spyOn(db, 'transaction').mockImplementation(() => transactionBoundary(transaction()))
        : vi.spyOn(adapter, 'update').mockImplementation((async (
            input: Parameters<typeof original>[0],
          ) => {
            if (input.model === 'organization') await demote()
            return original(input)
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
    expect(response.status).toBe(200)
    expect(
      await db
        .selectFrom('auth.invitation')
        .select('status')
        .where('id', '=', f.invitation.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: state === 'expired' ? 'canceled' : status })
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

  function invitationRequest(
    f: Fixture,
    method: 'GET' | 'POST',
    expected: string | null = f.team.id,
    options: {
      id?: string
      authorization?: string
      source?: string | null
      body?: object
      selected?: ReturnType<typeof createApp>
    } = {},
  ) {
    return (options.selected ?? app).request(
      `/api/v1/team/invitations/${options.id ?? f.invitation.id}${method === 'POST' ? '/cancel' : ''}`,
      {
        method,
        headers: {
          cookie: f.cookie,
          ...(options.source === null ? {} : { origin: options.source ?? origin }),
          'content-type': 'application/json',
          ...(expected === null ? {} : { 'x-expected-organization-id': expected }),
          ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
        },
        ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
      },
    )
  }

  it.each(['GET', 'POST'] as const)(
    'invitation %s uses current authority before missing-context recovery',
    async (method) => {
      for (const role of ['owner', 'admin', 'member', 'removed', 'unverified'] as const) {
        const f = await fixture(role)
        const allowed = role === 'owner' || role === 'admin'
        const response = await invitationRequest(f, method, null)
        expect(response.status, `${method}: ${role}`).toBe(
          allowed ? (method === 'GET' ? 200 : 409) : 403,
        )
        if (!allowed)
          expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
        await unchanged(f)
      }
    },
  )

  it.each(['GET', 'POST'] as const)(
    'invitation %s applies expected-team recovery and foreign target isolation',
    async (method) => {
      const f = await fixture()
      const other = await createTestTeam(db, [{ user: f.owner, role: 'owner' }])
      const foreign = await db
        .insertInto('auth.invitation')
        .values({
          organizationId: other.id,
          inviterId: f.owner.id,
          email: `${randomUUID()}@example.test`,
          role: 'member',
          status: 'pending',
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      for (const id of [foreign.id, randomUUID()]) {
        const response = await invitationRequest(f, method, f.team.id, { id })
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
      }
      for (const expected of ['malformed', other.id])
        expect((await invitationRequest(f, method, expected)).status).toBe(403)
      await db
        .updateTable('auth.session')
        .set({ activeOrganizationId: f.actor.principal.organization.id })
        .where('id', '=', f.sessionId)
        .execute()
      expect((await invitationRequest(f, method)).status).toBe(409)
      await db
        .updateTable('auth.member')
        .set({ role: 'member' })
        .where('organizationId', '=', f.team.id)
        .where('userId', '=', f.actor.id)
        .execute()
      expect((await invitationRequest(f, method)).status).toBe(403)
      await unchanged(f)
    },
  )

  it.each(['GET', 'POST'] as const)(
    'invitation %s rejects every Authorization boundary with a valid cookie',
    async (method) => {
      const f = await fixture()
      for (const authorization of [
        '',
        'Bearer hm_synthetic',
        'Bearer synthetic-oauth',
        'Basic synthetic',
      ]) {
        const response = await invitationRequest(f, method, f.team.id, { authorization })
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
      }
      await unchanged(f)
    },
  )

  it('invitation cancellation preserves cookie origin protection and refuses forged bodies', async () => {
    const f = await fixture()
    for (const source of ['https://foreign.example', 'null', null])
      expect((await invitationRequest(f, 'POST', f.team.id, { source })).status).toBe(403)
    expect(
      (await invitationRequest(f, 'POST', f.team.id, { body: { organizationId: randomUUID() } }))
        .status,
    ).toBe(400)
    await unchanged(f)
  })

  async function verifyInvitationMissingContext(routes: typeof teamInvitationRoutes) {
    const f = await fixture()
    const selected = createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
      routes: [routes({ db, invitationMailLimits: { secret } })],
    })
    expect((await invitationRequest(f, 'POST', null, { selected })).status).toBe(409)
    await unchanged(f)
  }

  async function invitationRouteCopy(mutate = false) {
    const location = new URL('./routes/team-invitations.ts', import.meta.url)
    let source = readFileSync(location, 'utf8')
    if (mutate) {
      const start = source.indexOf('    const writeHeaders = z.object({\n')
      const end = source.indexOf('    const params = z.object(')
      expect(start >= 0 && end > start, 'write header mutation anchor').toBe(true)
      source =
        source.slice(0, start) +
        source.slice(start, end).replace('.optional()', '') +
        source.slice(end)
    }
    const code = stripTypeScriptTypes(
      source.replace(/^import[\s\S]*?from '[^']+'\n/gm, ''),
    ).replace(/\bexport /g, '')
    const bindings = {
      createRoute,
      z,
      cancelTeamInvitation,
      TeamManagementError,
      DomainError,
      ErrorBody,
      json,
      listTeamInvitationSummaries,
      TeamInvitationSummarySchema,
      teamManagementAccess,
    }
    return new Function(...Object.keys(bindings), `${code}; return teamInvitationRoutes`)(
      ...Object.values(bindings),
    ) as typeof teamInvitationRoutes
  }

  it('passes invitation context recovery with the unchanged route source copy', async () => {
    await verifyInvitationMissingContext(await invitationRouteCopy())
  })

  it('detects generic validation bypassing invitation context recovery with a real assertion', async () => {
    await expect(
      verifyInvitationMissingContext(await invitationRouteCopy(true)),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  function sourceCopy(mutation?: 'authority' | 'identity'): typeof organizationContext {
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
    kind: 'authority' | 'missing context' | 'identity' | 'switch identity' = 'authority',
  ) {
    const f = await fixture('unverified')
    const session = await auth.api.getSession({ headers: new Headers({ cookie: f.cookie }) })
    expect(session).not.toBeNull()
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
    for (const kind of ['authority', 'missing context', 'identity', 'switch identity'] as const)
      await verifyAuthority(sourceCopy(), kind)
  })

  it.each(['authority', 'missing context', 'identity', 'switch identity'] as const)(
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

  async function contextCopy(mutate = false) {
    const location = new URL('../../../packages/auth/src/organization-context.ts', import.meta.url)
    let source = readFileSync(location, 'utf8')
    if (mutate) {
      const guard = '  if (!session) return\n'
      expect(source.includes(guard), 'native unauthenticated response mutation anchor').toBe(true)
      source = source.replace(
        guard,
        `  if (!session) {
    if (boundSwitch) return
    throw new APIError('FORBIDDEN', {
      code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
      message: 'team_management_access_denied',
    })
  }
`,
      )
    }
    const hooksLocation = new URL('../../../packages/auth/src/hooks.ts', import.meta.url)
    const authLocation = new URL('../../../packages/auth/src/index.ts', import.meta.url)
    const hooks = moduleUrl(readFileSync(hooksLocation, 'utf8'), hooksLocation, {
      './organization-context.ts': moduleUrl(source, location),
    })
    const { createAuth: factory } = (await import(
      moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, {
        './hooks.ts': hooks,
      })
    )) as { createAuth: typeof createAuth }
    return factory({
      pool,
      db,
      baseURL: origin,
      secret,
      signup: { mode: 'open', allowedDomains: [] },
      mailer: { send: async () => {} },
    })
  }

  it('passes native unauthenticated HTTP assertions with the original context source copy', async () => {
    const copy = await contextCopy()
    for (const path of paths) await verifyUnauthenticated(path, copy)
  })

  it('detects replacing native 401 with 403 through a real HTTP assertion', async () => {
    await expect(
      verifyUnauthenticated('update-member-role', await contextCopy(true)),
    ).rejects.toMatchObject({ name: 'AssertionError', actual: 403, expected: 401 })
  })

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

  it('detects removal of the update transaction guard through a real HTTP assertion', async () => {
    const branch = "if (ctx?.path === updateOrganization && request.model === 'organization') {"
    await expect(
      verifyRevocation('update', await policyCopy(branch, 'if (false) {')),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function cancellationCopy(mutation?: 'authorization' | 'lifecycle') {
    const location = new URL(
      '../../../packages/auth/src/invitation-cancellation.ts',
      import.meta.url,
    )
    let source = readFileSync(location, 'utf8')
    if (mutation === 'authorization') {
      const start = '        const facts = await checkTeamManagementAccess(\n'
      const end = "        if (facts.role === 'member') throw teamRoleDenied()\n"
      expect(source.includes(start), 'cancellation authorization mutation anchor').toBe(true)
      source =
        source.slice(0, source.indexOf(start)) +
        "        const facts = { role: 'owner', organizationId: target.organizationId, userId: session.user.id }\n" +
        source.slice(source.indexOf(end))
    }
    if (mutation === 'lifecycle') {
      const guard = "if (invitation.status !== 'pending') return invitation"
      expect(source.includes(guard), 'cancellation lifecycle mutation anchor').toBe(true)
      source = source
        .replace(guard, 'if (false) return invitation')
        .replace(".where('status', '=', 'pending')", '')
    }
    const hooksLocation = new URL('../../../packages/auth/src/hooks.ts', import.meta.url)
    const authLocation = new URL('../../../packages/auth/src/index.ts', import.meta.url)
    const hooks = moduleUrl(readFileSync(hooksLocation, 'utf8'), hooksLocation, {
      './invitation-cancellation.ts': moduleUrl(source, location),
    })
    const { createAuth: factory } = (await import(
      moduleUrl(readFileSync(authLocation, 'utf8'), authLocation, {
        './hooks.ts': hooks,
      })
    )) as { createAuth: typeof createAuth }
    return factory({
      pool,
      db,
      baseURL: origin,
      secret,
      signup: { mode: 'open', allowedDomains: [] },
      mailer: { send: async () => {} },
    })
  }

  it('passes the native cancellation boundary assertions with the original hook source copy', async () => {
    const copy = await cancellationCopy()
    await verifyRevocation('cancel-invitation', copy)
    for (const state of ['accepted', 'rejected', 'expired', 'canceled'] as const)
      await verifyTerminal(state, copy)
  })

  it('detects removal of native cancellation authorization through a real HTTP assertion', async () => {
    await expect(
      verifyRevocation('cancel-invitation', await cancellationCopy('authorization')),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each(['accepted', 'rejected'] as const)(
    'detects cancellation overwriting %s through a real HTTP assertion',
    async (state) => {
      await expect(
        verifyTerminal(state, await cancellationCopy('lifecycle')),
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
      ).rejects.toMatchObject({ name: 'AssertionError', actual: 200, expected: 403 })
    },
  )
})
