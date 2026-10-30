import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import {
  type Auth,
  checkTeamManagementAccess,
  createAuth,
  createAuthPool,
  createCallerResolver,
  TeamManagementError,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DomainError } from '@hourmere/scheduling/errors'
import { createTestTeam, createTestUser, testContext } from '@hourmere/scheduling/testing'
import * as webhooks from '@hourmere/webhooks'
import { createMiddleware } from 'hono/factory'
import { sql } from 'kysely'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { encryptWebhookSecret, newWebhookSecret } from '../../../packages/webhooks/src/crypto.ts'
import { createApp } from './app.ts'
import {
  authenticated,
  CROSS_ORIGIN_WRITE,
  errorResponses,
  json,
  serviceContext,
} from './openapi.ts'
import { webhookRoutes } from './routes/webhooks.ts'
import { EXPECTED_ORGANIZATION_HEADER } from './team-management.ts'

const bootstrap = process.env.DATABASE_URL
const origin = 'http://localhost:4378'
const sessionSecret = 'synthetic-webhook-context-session-secret-00000000000'
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 11).toString('base64') }
const input = { url: 'https://hooks.example.com/', events: ['booking.created'] }
const operations = ['create', 'update', 'delete', 'rotate'] as const
type Operation = (typeof operations)[number]
type Mutation = [string, string]

// Source copies leave real product files untouched, including when other files run in parallel.
function sourceCopy<T>(
  path: string,
  bindings: Record<string, unknown>,
  result: string,
  mutation?: Mutation,
): T {
  let source = readFileSync(path, 'utf8')
  if (mutation) {
    expect(source.includes(mutation[0]), 'mutation matches real product source').toBe(true)
    source = source.replace(...mutation)
  }
  const script = stripTypeScriptTypes(
    source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm, ''),
  ).replace(/\bexport /g, '')
  return new Function(...Object.keys(bindings), `${script}; return ${result}`)(
    ...Object.values(bindings),
  ) as T
}

function routeCopy(
  mutations: { service?: Mutation; context?: Mutation; route?: Mutation; auth?: Mutation } = {},
) {
  const shared = mutations.auth
    ? sourceCopy<Record<string, unknown>>(
        'packages/auth/src/team-management.ts',
        { sql },
        '({ checkTeamManagementAccess, TeamManagementError })',
        mutations.auth,
      )
    : { checkTeamManagementAccess, TeamManagementError }
  const context = sourceCopy<Record<string, unknown>>(
    'apps/server/src/team-management.ts',
    { sql, DomainError, createMiddleware, ...shared },
    '({ organizationContextAccess, organizationContextWriteLock })',
    mutations.context,
  )
  const service = sourceCopy<Record<string, unknown>>(
    'packages/webhooks/src/service.ts',
    {
      randomUUID,
      z,
      DomainError,
      encryptWebhookSecret,
      newWebhookSecret,
      webhookUrl: webhooks.webhookUrl,
    },
    '({ createWebhook, updateWebhook, deleteWebhook, rotateWebhookSecret, listWebhooks, listWebhookDeliveries, WEBHOOK_EVENTS, WebhookCreateInput, WebhookUpdateInput })',
    mutations.service,
  )
  return sourceCopy<typeof webhookRoutes>(
    'apps/server/src/routes/webhooks.ts',
    {
      createRoute,
      z,
      ...service,
      ...context,
      EXPECTED_ORGANIZATION_HEADER,
      authenticated,
      CROSS_ORIGIN_WRITE,
      errorResponses,
      json,
      serviceContext,
    },
    'webhookRoutes',
    mutations.route,
  )
}

describe.skipIf(!bootstrap)('webhook browser organization context', () => {
  let owned: TestDatabase
  let db: Db
  let auth: Auth
  let authPool: ReturnType<typeof createAuthPool>

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'webhook_context' })
    db = createDb(owned.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    // One fixture pool and one auth pool for this entire file; both close in teardown.
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret: sessionSecret,
      signup,
      mailer: {
        send: async () => {
          throw new Error('Real mail forbidden')
        },
      },
    })
  })
  afterAll(async () => {
    try {
      await authPool?.end()
    } finally {
      await owned?.drop()
    }
  })

  function application(factory = webhookRoutes, afterResolve?: () => Promise<void>) {
    const resolve = createCallerResolver({ auth, db })
    return createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: async (headers) => {
        const result = await resolve(headers)
        if (result.ok) await afterResolve?.()
        return result
      },
      routes: [factory({ db, ...settings })],
    })
  }

  const webhookSnapshot = (organizationIds: string[]) =>
    db
      .selectFrom('webhooks')
      .select(['id', 'organization_id', 'is_active', 'events', 'secret_ciphertext', 'updated_at'])
      .where('organization_id', 'in', organizationIds)
      .orderBy('id')
      .execute()

  async function fixture() {
    const user = await createTestUser(db, 'Webhook owner and admin')
    const owner = await createTestUser(db, 'Continuing team owner')
    const first = await createTestTeam(db, [
      { user, role: 'owner' },
      { user: owner, role: 'owner' },
    ])
    const second = await createTestTeam(db, [
      { user, role: 'admin' },
      { user: owner, role: 'owner' },
    ])
    const memberTeam = await createTestTeam(db, [{ user, role: 'member' }])
    const firstWebhook = await webhooks.createWebhook(
      testContext(db, first.as(user)),
      settings,
      input,
    )
    const secondWebhook = await webhooks.createWebhook(
      testContext(db, second.as(user)),
      settings,
      input,
    )
    const organizationIds = [
      first.id,
      second.id,
      user.principal.organization.id,
      owner.principal.organization.id,
    ]
    const snapshot = await webhookSnapshot(organizationIds)
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token,
        activeOrganizationId: first.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', sessionSecret).update(token).digest('base64')
    return {
      user,
      owner,
      first,
      second,
      memberTeam,
      organizationIds,
      firstWebhook: firstWebhook.webhook,
      secondWebhook: secondWebhook.webhook,
      snapshot,
      sessionId: session.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function personalFixture() {
    const f = await fixture()
    const ownPersonalWebhook = await webhooks.createWebhook(
      testContext(db, f.user.principal),
      settings,
      input,
    )
    const foreignPersonalWebhook = await webhooks.createWebhook(
      testContext(db, f.owner.principal),
      settings,
      input,
    )
    return {
      ...f,
      ownPersonalWebhook: ownPersonalWebhook.webhook,
      foreignPersonalWebhook: foreignPersonalWebhook.webhook,
      snapshot: await webhookSnapshot(f.organizationIds),
    }
  }
  const switchTo = (f: Fixture, id: string) =>
    db
      .updateTable('auth.session')
      .set({ activeOrganizationId: id })
      .where('id', '=', f.sessionId)
      .execute()

  function request(
    f: Fixture,
    operation: Operation | 'list' | 'deliveries',
    expected: string | null = f.first.id,
    app = application(),
    targetId = f.firstWebhook.id,
    authorization?: string,
  ) {
    const method =
      operation === 'list' || operation === 'deliveries'
        ? 'GET'
        : operation === 'update'
          ? 'PATCH'
          : operation === 'delete'
            ? 'DELETE'
            : 'POST'
    const path =
      operation === 'create' || operation === 'list'
        ? '/api/v1/webhooks'
        : `/api/v1/webhooks/${targetId}${operation === 'rotate' ? '/rotate-secret' : operation === 'deliveries' ? '/deliveries' : ''}`
    const body =
      operation === 'create' ? input : operation === 'update' ? { isActive: false } : undefined
    return app.request(path, {
      method,
      headers: {
        cookie: f.cookie,
        origin,
        ...(authorization === undefined ? {} : { authorization }),
        ...(expected === null ? {} : { [EXPECTED_ORGANIZATION_HEADER]: expected }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  async function unchanged(f: Fixture) {
    const rows = await webhookSnapshot(f.organizationIds)
    expect(rows.length).toBe(f.snapshot.length)
    // Do not print signing material in a failed assertion.
    expect(
      rows.every((row, i) =>
        row.secret_ciphertext.equals(f.snapshot[i]?.secret_ciphertext ?? Buffer.alloc(0)),
      ),
    ).toBe(true)
    expect(rows.map(({ secret_ciphertext: _, ...row }) => row)).toEqual(
      f.snapshot.map(({ secret_ciphertext: _, ...row }) => row),
    )
  }
  async function refused(response: Response, status = 409) {
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({
      error: status === 409 ? 'organization_context_changed' : 'team_management_access_denied',
    })
  }

  it.each(operations)(
    '%s refuses a stale owner-A page after switching to admin-B',
    async (operation) => {
      const f = await fixture()
      await switchTo(f, f.second.id)
      await refused(await request(f, operation))
      await unchanged(f)
    },
  )
  it.each(operations)(
    '%s requires the header and refuses malformed context like event types',
    async (operation) => {
      const f = await fixture()
      for (const expected of [null, '', 'invalid'])
        await refused(await request(f, operation, expected))
      await unchanged(f)
    },
  )
  it.each(operations)(
    '%s preserves matching context and case-insensitive IDs',
    async (operation) => {
      const f = await fixture()
      expect((await request(f, operation, f.first.id.toUpperCase())).status).toBe(
        operation === 'create' ? 201 : operation === 'delete' ? 204 : 200,
      )
    },
  )
  it.each(['remove', 'member', 'missing', 'foreign personal'] as const)(
    'uniformly denies inaccessible expected context: %s',
    async (kind) => {
      const f = await fixture()
      if (kind === 'remove')
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', f.first.id)
          .where('userId', '=', f.user.id)
          .execute()
      if (kind === 'member')
        await db
          .updateTable('auth.member')
          .set({ role: 'member' })
          .where('organizationId', '=', f.first.id)
          .where('userId', '=', f.user.id)
          .execute()
      await switchTo(f, f.second.id)
      const expected =
        kind === 'missing'
          ? randomUUID()
          : kind === 'foreign personal'
            ? f.owner.principal.organization.id
            : f.first.id
      for (const operation of [...operations, 'list', 'deliveries'] as const)
        await refused(await request(f, operation, expected), 403)
      await unchanged(f)
    },
  )
  async function verifyPersonalContext(
    factory: typeof webhookRoutes,
    space: 'own' | 'foreign',
    operation: Operation | 'list' | 'deliveries',
  ) {
    const f = await personalFixture()
    // Open in personal space first, then submit through the same session in a team.
    await switchTo(f, f.user.principal.organization.id)
    await switchTo(f, f.second.id)
    const personal = space === 'own' ? f.ownPersonalWebhook : f.foreignPersonalWebhook
    const write = operations.includes(operation as Operation)
    await refused(
      await request(
        f,
        operation,
        personal.organizationId.toUpperCase(),
        application(factory),
        personal.id,
      ),
      space === 'own' && write ? 409 : 403,
    )
    await unchanged(f)
  }
  for (const space of ['own', 'foreign'] as const) {
    it.each(operations)(
      `%s refuses a stale ${space} personal page after switching to a team without any write`,
      (operation) => verifyPersonalContext(webhookRoutes, space, operation),
    )
    it.each(['list', 'deliveries'] as const)(
      `%s keeps denying a stale ${space} personal expectation on reads`,
      (operation) => verifyPersonalContext(webhookRoutes, space, operation),
    )
  }
  it.each(['personal', 'member'] as const)(
    'retains authorized expected-team recovery after switching to %s space',
    async (space) => {
      const f = await fixture()
      await switchTo(f, space === 'personal' ? f.user.principal.organization.id : f.memberTeam.id)
      for (const operation of [...operations, 'list', 'deliveries'] as const)
        await refused(await request(f, operation))
      await unchanged(f)
    },
  )
  it('denies a matching member-only context uniformly', async () => {
    const f = await fixture()
    await switchTo(f, f.memberTeam.id)
    for (const operation of [...operations, 'list', 'deliveries'] as const)
      await refused(await request(f, operation, f.memberTeam.id), 403)
  })
  it.each(['list', 'deliveries'] as const)(
    '%s reads keep omission behavior and enforce supplied context',
    async (operation) => {
      const f = await fixture()
      expect((await request(f, operation)).status).toBe(200)
      await switchTo(f, f.second.id)
      expect((await request(f, operation, null, application(), f.secondWebhook.id)).status).toBe(
        200,
      )
      await refused(await request(f, operation))
      for (const invalid of ['', 'invalid'])
        await refused(await request(f, operation, invalid), 403)
    },
  )
  it('keeps matching personal webhooks available and requires their write header', async () => {
    const f = await fixture()
    const personal = f.user.principal.organization.id
    await switchTo(f, personal)
    await refused(await request(f, 'create', null))
    expect((await request(f, 'create', personal)).status).toBe(201)
    expect((await request(f, 'list', personal)).status).toBe(200)
    expect((await request(f, 'list', null)).status).toBe(200)
  })
  it('keeps API keys pinned and ignores absent, forged and malformed browser headers', async () => {
    const f = await fixture()
    const key = await auth.api.createApiKey({
      body: { userId: f.user.id, metadata: { organizationId: f.first.id } },
    })
    await switchTo(f, f.second.id)
    const authorization = `Bearer ${key.key}`
    for (const expected of [null, f.second.id, 'invalid']) {
      const created = await request(
        f,
        'create',
        expected,
        application(),
        f.firstWebhook.id,
        authorization,
      )
      expect(created.status).toBe(201)
      const createdBody = (await created.json()) as { webhook: { organizationId: string } }
      expect(createdBody.webhook.organizationId).toBe(f.first.id)
      const listed = await request(
        f,
        'list',
        expected,
        application(),
        f.firstWebhook.id,
        authorization,
      )
      expect(listed.status).toBe(200)
      expect(
        ((await listed.json()) as { organizationId: string }[]).every(
          (row) => row.organizationId === f.first.id,
        ),
      ).toBe(true)
    }
    for (const operation of ['update', 'delete', 'rotate', 'deliveries'] as const)
      expect(
        (await request(f, operation, f.second.id, application(), f.secondWebhook.id, authorization))
          .status,
      ).toBe(404)
    expect(
      (await request(f, 'update', f.second.id, application(), f.firstWebhook.id, authorization))
        .status,
    ).toBe(200)
    for (const operation of ['deliveries', 'rotate', 'delete'] as const)
      expect(
        (await request(f, operation, f.second.id, application(), f.firstWebhook.id, authorization))
          .status,
      ).toBe(operation === 'delete' ? 204 : 200)
  })

  it.each(['switch', 'logout', 'expiry', 'demotion'] as const)(
    'rechecks %s committed after caller resolution',
    async (change) => {
      const f = await fixture()
      const app = application(webhookRoutes, async () => {
        if (change === 'switch') await switchTo(f, f.second.id)
        else if (change === 'logout')
          await db.deleteFrom('auth.session').where('id', '=', f.sessionId).execute()
        else if (change === 'expiry')
          await db
            .updateTable('auth.session')
            .set({ expiresAt: new Date(Date.now() - 60_000) })
            .where('id', '=', f.sessionId)
            .execute()
        else
          await db
            .updateTable('auth.member')
            .set({ role: 'member' })
            .where('organizationId', '=', f.first.id)
            .where('userId', '=', f.user.id)
            .execute()
      })
      await refused(await request(f, 'create', f.first.id, app), change === 'switch' ? 409 : 403)
      await unchanged(f)
    },
  )

  async function blockedBy(client: PoolClient) {
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
    await vi.waitFor(
      async () => {
        const result = await owned.pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',
          [pid],
        )
        expect(result.rows[0]?.n).toBeGreaterThan(0)
      },
      { timeout: 3000, interval: 10 },
    )
  }
  async function verifyWait(
    operation: Operation,
    change: 'switch' | 'demotion' | 'expiry' | 'logout',
    factory = webhookRoutes,
  ) {
    const f = await fixture()
    const holder = await owned.pool.connect()
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      if (operation === 'create')
        await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [f.first.id])
      else await holder.query('SELECT id FROM webhooks WHERE id=$1 FOR UPDATE', [f.firstWebhook.id])
      pending = Promise.resolve(request(f, operation, f.first.id, application(factory)))
      await blockedBy(holder)
      if (change === 'switch')
        await holder.query('UPDATE auth.session SET "activeOrganizationId"=$1 WHERE id=$2', [
          f.second.id,
          f.sessionId,
        ])
      else if (change === 'expiry')
        await holder.query('UPDATE auth.session SET "expiresAt"=$1 WHERE id=$2', [
          new Date(Date.now() - 60_000),
          f.sessionId,
        ])
      else if (change === 'logout')
        await holder.query('DELETE FROM auth.session WHERE id=$1', [f.sessionId])
      else
        await holder.query(
          'UPDATE auth.member SET role=$1 WHERE "organizationId"=$2 AND "userId"=$3',
          ['member', f.first.id, f.user.id],
        )
      await holder.query('COMMIT')
      const response = await pending
      expect(response.status).toBe(change === 'switch' ? 409 : 403)
      expect(await response.json()).toMatchObject({
        error:
          change === 'switch' ? 'organization_context_changed' : 'team_management_access_denied',
      })
      await unchanged(f)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await pending
    }
  }
  for (const operation of operations) {
    it.each(['switch', 'demotion', 'expiry', 'logout'] as const)(
      `${operation} rechecks %s committed during its locked-path wait`,
      (change) => verifyWait(operation, change),
    )
  }
  async function verifyFence(factory = webhookRoutes) {
    const f = await fixture()
    const holder = await owned.pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `hourmere.organization-context:${f.sessionId}`,
      ])
      await refused(await request(f, 'create', f.first.id, application(factory)))
      await unchanged(f)
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
    }
  }
  it('refuses contention with the native organization transition fence before parent locks', () =>
    verifyFence())
  async function verifyConcurrent(factory = webhookRoutes) {
    const f = await fixture()
    const extra = await webhooks.createWebhook(testContext(db, f.first.as(f.user)), settings, input)
    const app = application(factory)
    const holder = await owned.pool.connect()
    let pending: Promise<Response[]> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM webhooks WHERE id=ANY($1::uuid[]) FOR UPDATE', [
        [f.firstWebhook.id, extra.webhook.id],
      ])
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      pending = Promise.all(
        [f.firstWebhook.id, extra.webhook.id].map((id) =>
          request(f, 'update', f.first.id, app, id),
        ),
      )
      // Both writers hold organization KEY SHARE before either final check. A late
      // organization UPDATE upgrade now necessarily deadlocks.
      await vi.waitFor(
        async () => {
          const result = await owned.pool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',
            [pid],
          )
          expect(result.rows[0]?.n).toBe(2)
        },
        { timeout: 3000, interval: 10 },
      )
      await holder.query('COMMIT')
      expect((await pending).map((response) => response.status)).toEqual([200, 200])
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await pending
    }
  }
  it('updates different endpoints concurrently without upgrading organization locks', () =>
    verifyConcurrent())

  async function verifyScenario(
    factory: typeof webhookRoutes,
    scenario: 'stale' | 'missing' | 'invalid' | 'inaccessible' | 'read' | 'read invalid' | 'key',
  ) {
    const f = await fixture()
    const app = application(factory)
    if (scenario === 'missing') await refused(await request(f, 'create', null, app))
    else if (scenario === 'invalid') await refused(await request(f, 'create', 'invalid', app))
    else if (scenario === 'read invalid')
      await refused(await request(f, 'list', 'invalid', app), 403)
    else {
      await switchTo(f, f.second.id)
      if (scenario === 'key') {
        const key = await auth.api.createApiKey({
          body: { userId: f.user.id, metadata: { organizationId: f.first.id } },
        })
        const response = await request(
          f,
          'create',
          f.second.id,
          app,
          f.firstWebhook.id,
          `Bearer ${key.key}`,
        )
        expect(response.status).toBe(201)
        const createdBody = (await response.json()) as { webhook: { organizationId: string } }
        expect(createdBody.webhook.organizationId).toBe(f.first.id)
      } else {
        if (scenario === 'inaccessible')
          await db
            .deleteFrom('auth.member')
            .where('organizationId', '=', f.first.id)
            .where('userId', '=', f.user.id)
            .execute()
        await refused(
          await request(f, scenario === 'read' ? 'list' : 'create', f.first.id, app),
          scenario === 'inaccessible' ? 403 : 409,
        )
      }
    }
  }
  it('passes real HTTP assertions with unchanged isolated source copies', async () => {
    const factory = routeCopy()
    for (const scenario of [
      'stale',
      'missing',
      'invalid',
      'inaccessible',
      'read',
      'read invalid',
      'key',
    ] as const)
      await verifyScenario(factory, scenario)
    await verifyWait('create', 'switch', factory)
    await verifyWait('update', 'switch', factory)
    await verifyFence(factory)
    for (const space of ['own', 'foreign'] as const)
      for (const operation of [...operations, 'list', 'deliveries'] as const)
        await verifyPersonalContext(factory, space, operation)
  })
  it.each([
    [
      'own personal-space write recovery',
      'own',
      operations,
      ['ownPersonal !== undefined ||\n        ', ''],
      403,
      409,
    ],
    [
      'personal-space ownership',
      'foreign',
      operations,
      [
        ".where('organization_id', '=', expectedOrganizationId)\n          .where('user_id', '=', principal.user.id)",
        ".where('organization_id', '=', expectedOrganizationId)",
      ],
      409,
      403,
    ],
    [
      'existing personal-space read policy',
      'own',
      ['list', 'deliveries'],
      ['const ownPersonal = write\n', 'const ownPersonal = true\n'],
      409,
      403,
    ],
  ] as const)(
    'detects removing %s with real HTTP assertions',
    async (_, space, attemptedOperations, mutation, actual, expected) => {
      const factory = routeCopy({ context: [...mutation] })
      for (const operation of attemptedOperations)
        await expect(verifyPersonalContext(factory, space, operation)).rejects.toThrow(
          expect.objectContaining({ name: 'AssertionError', actual, expected }),
        )
    },
  )
  it.each([
    [
      'missing write context',
      'missing',
      { context: ['if (write) throw contextChanged()', 'if (write) return'] },
    ],
    [
      'malformed write context refusal',
      'invalid',
      { context: ['throw write ? contextChanged() : denied()', 'throw denied()'] },
    ],
    [
      'expected-team authority',
      'inaccessible',
      {
        context: [
          'expectedOrganizationId.toLowerCase() === principal.organization.id.toLowerCase(),',
          'true,',
        ],
      },
    ],
    [
      'optional read context',
      'read',
      {
        route: [
          'await organizationContextAccess(principal, expectedOrganizationId)(',
          'await organizationContextAccess(principal, undefined)(',
        ],
      },
    ],
    [
      'invalid read context denial',
      'read invalid',
      { context: ['throw write ? contextChanged() : denied()', 'throw contextChanged()'] },
    ],
    [
      'API-key header independence',
      'key',
      {
        context: [
          "if (principal.kind !== 'session') return\n    if (expectedOrganizationId",
          'if (expectedOrganizationId',
        ],
      },
    ],
  ] as const)('detects removing %s with a real HTTP assertion', async (_, scenario, mutations) => {
    await expect(
      verifyScenario(routeCopy(mutations as Parameters<typeof routeCopy>[0]), scenario),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
  it.each(['create', 'update'] as const)(
    'detects removing the final %s context recheck',
    async (operation) => {
      const source = 'await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id)'
      const mutation: Mutation =
        operation === 'create'
          ? [source, '/* context recheck removed */']
          : [
              `${source}\n  await requireAdmin(trx, ctx, true)`,
              'await requireAdmin(trx, ctx, true)',
            ]
      await expect(
        verifyWait(operation, 'switch', routeCopy({ service: mutation })),
      ).rejects.toThrow(
        expect.objectContaining({
          name: 'AssertionError',
          actual: operation === 'create' ? 201 : 200,
          expected: 409,
        }),
      )
    },
  )
  it('detects removing the native transition fence', async () => {
    await expect(
      verifyFence(
        routeCopy({
          route: [
            'await organizationContextWriteLock(principal)(trx)',
            '/* native fence removed */',
          ],
        }),
      ),
    ).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError', actual: 201, expected: 409 }),
    )
  })
  it('detects upgrading organization locks during the final context recheck', async () => {
    await expect(
      verifyConcurrent(
        routeCopy({
          auth: [
            "if (lock === 'key share') organizationQuery = organizationQuery.forKeyShare()",
            "if (lock === 'key share') organizationQuery = organizationQuery.forUpdate()",
          ],
        }),
      ),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
})
