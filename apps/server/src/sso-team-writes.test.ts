import { randomBytes } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
} from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { Kysely, PostgresDialect, TableNode, UpdateQueryNode } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type IdentityFixture,
  identityFixture,
  link,
  proofValues,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import { insert } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { openApiRouteInventory } from './openapi-document.ts'
import { productRoutes } from './server.ts'
import { databaseClock } from './sso-mailbox-proof.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const

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
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl,
      routes: productRoutes({
        db: routeDb,
        publicUrl,
        socialProviders: {},
        invitationMailLimits: { secret },
        meetingPollSecret: secret,
        routingFormsEnabled: true,
        routingSecret: secret,
        scimProvisioningEnabled: true,
        ssoOidcEnabled: enabled,
        ssoConfigurationKey: Buffer.alloc(32),
        webhooks: { enabled: true },
      }),
      ...(enforce && {
        ssoTeamReads: { db, capabilities: { ssoOidcEnabled: enabled, ssoSamlEnabled: false } },
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
      const response = await send(app, method, path, {})
      if (path.startsWith('/api/v1/workflows')) {
        expect(response.status, operation).toBe(404)
        expect(await response.json(), operation).toMatchObject({ error: 'workflows_disabled' })
      } else {
        await expectRefused(response, operation)
      }
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
      return { transaction, policyLookups: statements.filter((s) => s.includes('sso_policies')) }
    }

    const legacy = await trace(false, 'First update')
    const protectedWrite = await trace(true, 'Second update')
    expect(protectedWrite.transaction).toEqual(legacy.transaction)
    expect(protectedWrite.policyLookups).toHaveLength(1)
    expect(await currentTitle()).toBe('Second update')
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

  it('rolls back a write when another transaction revokes its proof before commit', async () => {
    await requireSso()
    await grantProof()
    expect((await updateEvent(instance(), 'Live proof')).status).toBe(200)

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
    const writing = updateEvent(instance({ routeDb: writerDb }), 'Must roll back')
    try {
      await Promise.race([
        wrote.promise,
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
      release.resolve()
    }
    await expectRefused(await writing)
    expect(await currentTitle()).toBe('Live proof')
  })
})
