import { randomBytes } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  lockSharedTeamSsoProof,
} from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { teamWriteTransaction } from '@hourmere/db/team-write'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { Kysely, PostgresDialect, TableNode, UpdateQueryNode } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindingValues,
  type IdentityFixture,
  identityFixture,
  link,
  proofValues,
  seeded,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import { insert, sealed } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { openApiRouteInventory } from './openapi-document.ts'
import { productRoutes } from './server.ts'
import { databaseClock } from './sso-mailbox-proof.ts'
import { teamReadAccess } from './sso-team-reads.ts'
import { withTeamWriteAccess } from './sso-write-middleware.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const
const enabledCapabilities = { ssoOidcEnabled: true, ssoSamlEnabled: false }

describe.skipIf(!serverUrl)('SSO proof on team writes', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let fixture: IdentityFixture
  let actor: Awaited<ReturnType<typeof browser>>
  let eventId: string
  const statements: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'team_sso_write' })
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('This test needs no email') },
    })
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  beforeEach(async () => {
    const client = await owned.pool.connect()
    try {
      fixture = await identityFixture(client)
    } finally {
      client.release()
    }
    actor = await browser(fixture.owner)
    eventId = await createFixtures(db).eventType(fixture.team, null, {
      title: 'Before writing',
      hosts: [{ userId: fixture.owner }],
    })
  })

  async function browser(userId: string) {
    const result = await db.transaction().execute(async (trx) =>
      createBrowserSession(
        trx,
        { publicUrl, secret },
        {
          userId,
          organizationId: fixture.team,
          now: await databaseClock(trx),
          headers: new Headers(),
        },
      ),
    )
    return { id: result.id, cookie: result.cookie.split(';')[0] as string }
  }

  async function requireSso() {
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, require_sso: true })
      .execute()
  }

  async function grantProof(user: 'owner' | 'member' = 'owner') {
    const client = await owned.pool.connect()
    try {
      const actorLink =
        user === 'member'
          ? fixture.memberLink
          : await link({ ...fixture, db: client }, fixture.owner)
      await insert(client, 'sso_browser_proofs', {
        ...proofValues(fixture, actorLink),
        member_id: fixture[`${user}Member`],
        session_id: actor.id,
      })
    } finally {
      client.release()
    }
  }

  function instance({ enabled = true, enforce = true, routeDb = db } = {}) {
    const capabilities = { ssoOidcEnabled: enabled, ssoSamlEnabled: false }
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db, ssoCapabilities: capabilities }),
      publicUrl,
      routes: productRoutes({
        db: routeDb,
        publicUrl,
        socialProviders: {},
        invitationMailLimits: { secret },
        meetingPollSecret: secret,
        routingFormsEnabled: true,
        routingSecret: secret,
        workflowsEnabled: true,
        scimProvisioningEnabled: true,
        ssoOidcEnabled: enabled,
        ssoConfigurationKey: Buffer.alloc(32),
        webhooks: { enabled: true },
      }),
      ...(enforce && {
        ssoTeamReads: { db, capabilities },
      }),
    })
  }

  async function send(
    app: ReturnType<typeof instance>,
    method: string,
    path: string,
    body: unknown,
  ) {
    return app.request(new URL(path, publicUrl), {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: actor.cookie,
        origin: publicUrl,
        'x-expected-organization-id': fixture.team,
      },
      body: JSON.stringify(body),
    })
  }

  const updateEvent = (app: ReturnType<typeof instance>, title: string) =>
    send(app, 'PATCH', `/api/v1/event-types/${eventId}`, { title })

  const currentTitle = async () =>
    (
      await db
        .selectFrom('event_types')
        .select('title')
        .where('id', '=', eventId)
        .executeTakeFirst()
    )?.title

  async function expectRefused(response: Response, operation?: string) {
    expect(response.status, operation).toBe(403)
    expect(await response.json(), operation).toMatchObject({ error: 'sso_required' })
    expect(response.headers.get('location'), operation).toBeNull()
  }

  const issueKey = () =>
    auth.api.createApiKey({
      body: {
        userId: fixture.owner,
        metadata: { organizationId: fixture.team, scope: 'full' },
      },
    })

  const writeAsKey = (app: ReturnType<typeof instance>, authorization: string, title: string) =>
    app.request(new URL(`/api/v1/event-types/${eventId}`, publicUrl), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ title }),
    })

  async function delegatedKey(expiresInMs?: number) {
    const key = await issueKey()
    const client = await owned.pool.connect()
    try {
      const actorLink = await link({ ...fixture, db: client }, fixture.owner)
      const binding = {
        ...bindingValues(fixture, { api_key_id: key.id }, actorLink),
        member_id: fixture.ownerMember,
      }
      if (expiresInMs !== undefined) {
        await client.query('BEGIN')
        try {
          const { rows } = await client.query<{ started: Date; deadline: Date }>(
            `
            SELECT t - interval '2592000 seconds' AS started, t AS deadline
            FROM (SELECT clock_timestamp() + $1::integer * interval '1 millisecond' AS t) clock
          `,
            [expiresInMs],
          )
          await seeded(client, 'sso_delegation_bindings', {
            ...binding,
            created_at: rows[0]?.started,
            expires_at: rows[0]?.deadline,
          })
          await client.query('COMMIT')
        } finally {
          await client.query('ROLLBACK')
        }
      } else {
        await insert(client, 'sso_delegation_bindings', binding)
      }
    } finally {
      client.release()
    }
    const authorization = `Bearer ${key.key}`
    return {
      id: key.id,
      authorization,
      write: (app: ReturnType<typeof instance>, title: string) =>
        writeAsKey(app, authorization, title),
    }
  }

  it('refuses unauthenticated-by-SSO writes when a policy is seeded with the protocol hard-off', async () => {
    await requireSso()
    await grantProof()
    await expectRefused(await updateEvent(instance({ enabled: false }), 'Refused'))
    expect(await currentTitle()).toBe('Before writing')
  })

  it('checks every registered team write with operational features enabled', async () => {
    await requireSso()
    const app = instance()
    const { teamWriteRoutes } = await openApiRouteInventory()
    for (const operation of teamWriteRoutes) {
      const [method, pattern] = operation.split(' ') as [string, string]
      const path = pattern.replace(/:(\w+)/g, (_match, key: string) => {
        if (['teamId', 'organizationId'].includes(key)) return fixture.team
        if (key === 'providerId') return String(fixture.provider.id)
        if (key === 'domainId') return String(fixture.domain.id)
        return eventId
      })
      await expectRefused(await send(app, method, path, {}), operation)
    }
    expect(await currentTitle()).toBe('Before writing')
  })

  it('adds one memoized request lookup and leaves the no-policy committing SQL and locks identical', async () => {
    async function trace(enforce: boolean, title: string) {
      const app = instance({ enforce })
      statements.length = 0
      const response = await updateEvent(app, title)
      expect(response.status).toBe(200)
      const begin = statements.indexOf('begin')
      const commit = statements.indexOf('commit', begin)
      expect(begin).toBeGreaterThanOrEqual(0)
      expect(commit).toBeGreaterThan(begin)
      const transaction = statements.slice(begin, commit + 1)
      expect(transaction.some((statement) => statement.startsWith('update "event_types"'))).toBe(
        true,
      )
      return { transaction, statements: [...statements] }
    }

    const legacy = await trace(false, 'First update')
    const protectedWrite = await trace(true, 'Second update')
    expect(protectedWrite.transaction).toEqual(legacy.transaction)
    expect(protectedWrite.statements.filter((s) => s.includes('sso_policies'))).toHaveLength(1)

    // Main already locks the stored policy at commit, even when enforcement is off.
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, require_sso: false })
      .execute()
    const unenforced = await trace(true, 'Third update')
    expect(unenforced.statements.filter((s) => s.includes('sso_policies'))).toHaveLength(2)
    expect(unenforced.statements.filter((s) => !s.includes('sso_policies'))).toEqual(
      protectedWrite.statements.filter((s) => !s.includes('sso_policies')),
    )
    expect(await currentTitle()).toBe('Third update')
  })

  it('lets a member with live proof leave the team and revoke that proof atomically', async () => {
    await requireSso()
    actor = await browser(fixture.member)
    await grantProof('member')

    const response = await send(instance(), 'POST', `/api/v1/teams/${fixture.team}/leave`, {})
    expect(response.status).toBe(200)
    const personal = await db
      .selectFrom('personal_organizations')
      .select('organization_id')
      .where('user_id', '=', fixture.member)
      .executeTakeFirstOrThrow()
    expect(await response.json()).toEqual({ organizationId: personal.organization_id })
    expect(
      await db
        .selectFrom('auth.session')
        .select('activeOrganizationId')
        .where('id', '=', actor.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ activeOrganizationId: personal.organization_id })
    expect(
      await db
        .selectFrom('auth.member')
        .select('id')
        .where('id', '=', fixture.memberMember)
        .executeTakeFirst(),
    ).toBeUndefined()
    expect(
      await db
        .selectFrom('sso_browser_proofs')
        .select('id')
        .where('session_id', '=', actor.id)
        .executeTakeFirst(),
    ).toBeUndefined()
  })

  function pauseEventWrite() {
    const wrote = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const eventUpdates = new Set<unknown>()
    const writerDb = db.withPlugin({
      transformQuery({ node, queryId }) {
        if (
          UpdateQueryNode.is(node) &&
          node.table &&
          TableNode.is(node.table) &&
          node.table.table.identifier.name === 'event_types'
        )
          eventUpdates.add(queryId)
        return node
      },
      async transformResult({ result, queryId }) {
        if (eventUpdates.delete(queryId)) {
          wrote.resolve()
          await release.promise
        }
        return result
      },
    })
    return { wrote: wrote.promise, release: release.resolve, writerDb }
  }

  async function waitForBlocked(pid: number | undefined) {
    await vi.waitFor(async () => {
      const blocked = await owned.pool.query(
        'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [pid],
      )
      expect(blocked.rowCount).toBe(1)
    })
  }

  it('rolls back a write when another transaction revokes its proof before commit', async () => {
    await requireSso()
    await grantProof()
    expect((await updateEvent(instance(), 'Live proof')).status).toBe(200)

    const { wrote, release, writerDb } = pauseEventWrite()
    const writing = updateEvent(instance({ routeDb: writerDb }), 'Must roll back')
    try {
      await Promise.race([
        wrote,
        writing.then(({ status }) => {
          throw new Error(`Request finished with ${status} before reaching the write`)
        }),
      ])
      await db.transaction().execute(async (trx) => {
        expect(
          (
            await trx
              .selectFrom('event_types')
              .select('title')
              .where('id', '=', eventId)
              .executeTakeFirst()
          )?.title,
        ).toBe('Live proof')
        const removed = await trx
          .deleteFrom('sso_browser_proofs')
          .where('session_id', '=', actor.id)
          .executeTakeFirst()
        expect(removed.numDeletedRows).toBe(1n)
      })
    } finally {
      release()
    }
    await expectRefused(await writing)
    expect(await currentTitle()).toBe('Live proof')
  })

  it('denies a lease at 30 days and leaves the write unchanged', async () => {
    await requireSso()
    const { write } = await delegatedKey(0)
    await expectRefused(await write(instance(), 'Expired lease'))
    expect(await currentTitle()).toBe('Before writing')
  })

  it('rolls back a delegated write that crosses the 30-day deadline in a lock wait', async () => {
    await requireSso()
    const { wrote, release, writerDb } = pauseEventWrite()
    const app = instance({ routeDb: writerDb })
    const { id, write } = await delegatedKey(2500)
    const blocker = await owned.pool.connect()
    const writing = Promise.resolve(write(app, 'Must roll back'))
    try {
      await Promise.race([
        wrote,
        writing.then(({ status }) => {
          throw new Error(`Request finished with ${status} before reaching the write`)
        }),
      ])
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM sso_domains WHERE id = $1 FOR UPDATE', [
        fixture.domain.id,
      ])
      const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      release()
      await waitForBlocked(rows[0]?.pid)
      await vi.waitFor(
        async () => {
          const { rows } = await blocker.query<{ expired: boolean }>(
            'SELECT expires_at <= clock_timestamp() AS expired FROM sso_delegation_bindings WHERE api_key_id = $1',
            [id],
          )
          expect(rows[0]?.expired).toBe(true)
        },
        { timeout: 3500, interval: 50 },
      )
    } finally {
      release()
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    await expectRefused(await writing)
    expect(await currentTitle()).toBe('Before writing')
  }, 8000)

  it.each(['domain deletion', 'provider trust change'] as const)(
    'rolls back a delegated write racing with %s',
    async (change) => {
      await requireSso()
      const { write } = await delegatedKey()
      expect((await write(instance(), 'Live delegation')).status).toBe(200)
      const { wrote, release, writerDb } = pauseEventWrite()
      const revoker = await owned.pool.connect()
      const writing = Promise.resolve(write(instance({ routeDb: writerDb }), 'Must roll back'))
      try {
        await Promise.race([
          wrote,
          writing.then(({ status }) => {
            throw new Error(`Request finished with ${status} before reaching the write`)
          }),
        ])
        await revoker.query('BEGIN')
        if (change === 'domain deletion') {
          await revoker.query(
            'UPDATE sso_domains SET retired_at = clock_timestamp() WHERE id = $1',
            [fixture.domain.id],
          )
        } else {
          await revoker.query(
            'UPDATE sso_policies SET trust_generation = trust_generation + 1 WHERE organization_id = $1',
            [fixture.team],
          )
          await revoker.query(
            'UPDATE sso_providers SET revision = revision + 1, configuration = $2 WHERE id = $1',
            [fixture.provider.id, sealed()],
          )
        }
        const { rows } = await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        release()
        await waitForBlocked(rows[0]?.pid)
        await revoker.query('COMMIT')
      } finally {
        release()
        await revoker.query('ROLLBACK')
        revoker.release()
      }
      await expectRefused(await writing)
      expect(await currentTitle()).toBe('Live delegation')
    },
  )

  it('rechecks membership on the committing connection when removal wins the race', async () => {
    await requireSso()
    const { authorization } = await delegatedKey()
    const resolve = createCallerResolver({ auth, db, ssoCapabilities: enabledCapabilities })
    const caller = await resolve(new Headers({ authorization }))
    if (!caller.ok) throw new Error('The live key must authenticate before removal')
    const { principal } = caller
    const deps = { db, capabilities: enabledCapabilities }
    const { wrote, release, writerDb } = pauseEventWrite()
    // Production event-type edits also lock the acting membership first. Exercise the
    // shared SSO commit check with a write that can reach it while removal holds that row.
    const writing = withTeamWriteAccess(deps, principal, teamReadAccess(deps, principal), () =>
      teamWriteTransaction(writerDb.transaction(), (trx) =>
        trx
          .updateTable('event_types')
          .set({ title: 'Must roll back' })
          .where('id', '=', eventId)
          .execute(),
      ),
    )
    const denied = expect(writing).rejects.toMatchObject({ message: 'sso_required' })
    const revoker = await owned.pool.connect()
    try {
      await wrote
      await revoker.query('BEGIN')
      await revoker.query('DELETE FROM auth.member WHERE id = $1', [fixture.ownerMember])
      const { rows } = await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      release()
      await waitForBlocked(rows[0]?.pid)
      await revoker.query('COMMIT')
    } finally {
      release()
      await revoker.query('ROLLBACK')
      revoker.release()
    }
    await denied
    expect(await currentTitle()).toBe('Before writing')
  })

  it('keeps another member’s delegation after membership removal', async () => {
    await requireSso()
    const { write } = await delegatedKey()
    const { wrote, release, writerDb } = pauseEventWrite()
    const writing = Promise.resolve(write(instance({ routeDb: writerDb }), 'Still authorized'))
    try {
      await Promise.race([
        wrote,
        writing.then(({ status }) => {
          throw new Error(`Request finished with ${status} before reaching the write`)
        }),
      ])
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('auth.member').where('id', '=', fixture.memberMember).execute()
      })
    } finally {
      release()
    }
    expect((await writing).status).toBe(200)
    expect(await currentTitle()).toBe('Still authorized')
  })

  it('rechecks a stored policy enabled during a machine write', async () => {
    await db.insertInto('sso_policies').values({ organization_id: fixture.team }).execute()
    const key = await issueKey()
    const { wrote, release, writerDb } = pauseEventWrite()
    const writing = Promise.resolve(
      writeAsKey(instance({ routeDb: writerDb }), `Bearer ${key.key}`, 'Must roll back'),
    )
    try {
      await Promise.race([
        wrote,
        writing.then(({ status }) => {
          throw new Error(`Request finished with ${status} before reaching the write`)
        }),
      ])
      await db
        .updateTable('sso_policies')
        .set({ require_sso: true, policy_revision: 2 })
        .where('organization_id', '=', fixture.team)
        .execute()
    } finally {
      release()
    }
    await expectRefused(await writing)
    expect(await currentTitle()).toBe('Before writing')
  })

  it('keeps browser-only proof checks independent of an ambient machine lease', async () => {
    await requireSso()
    const { authorization } = await delegatedKey()
    const deps = { db, capabilities: enabledCapabilities }
    const caller = await createCallerResolver({ auth, db, ssoCapabilities: enabledCapabilities })(
      new Headers({ authorization }),
    )
    if (!caller.ok) throw new Error('The live key must authenticate')
    await expect(
      withTeamWriteAccess(deps, caller.principal, teamReadAccess(deps, caller.principal), () =>
        db.transaction().execute((trx) =>
          lockSharedTeamSsoProof(trx, enabledCapabilities, null, fixture.team, () => {
            throw new Error('Browser proof required')
          }),
        ),
      ),
    ).rejects.toThrow('Browser proof required')
  })
})
