import { randomUUID } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { auditLogRoutes } from './routes/audit-log.ts'
import { eventTypeRoutes } from './routes/event-types.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'
import { scimDiscovery } from './scim-discovery.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const secret = 'synthetic-hierarchy-isolation-secret-00000000000'
const signup = { mode: 'open', allowedDomains: [] } as const

describe.skipIf(!databaseUrl)('SCIM hierarchy does not extend team authority', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, {
      tag: 'scim_hier_iso',
    })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, signup)
    const auth = createAuth({
      db,
      pool,
      signup,
      secret,
      baseURL: publicUrl,
      scimResourcesEnabled: true,
      mailer: { send: async () => expect.unreachable('No mail expected') },
    })
    app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      scim: { db, enabled: true, resources: scimDiscovery },
      routes: [
        eventTypeRoutes({ db }),
        teamBookingRoutes({ db }),
        auditLogRoutes({ db, auditLogRetentionDays: 90 }),
      ],
    })
  })

  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  const organizationPath = '/api/auth/organization'

  async function team(name: string) {
    const owner = await createTestUser(db, `${name} owner`)
    const admin = await createTestUser(db, `${name} admin`)
    const { id } = await createTestTeam(
      db,
      [
        { user: owner, role: 'owner' },
        { user: admin, role: 'admin' },
      ],
      name,
    )
    const fixtures = createFixtures(db)
    const event = await fixtures.eventType(id, null, {
      title: `${name} private event`,
      hosts: [{ userId: owner.id }],
      isActive: false,
    })
    const booking = await fixtures.booking(
      id,
      [owner.id],
      '2031-06-03T12:00:00Z',
      '2031-06-03T12:30:00Z',
      { eventTypeId: event },
    )
    async function browser(userId: string) {
      const session = await db.transaction().execute((trx) =>
        createBrowserSession(
          trx,
          { publicUrl, secret },
          {
            userId,
            organizationId: id,
            now: Temporal.Now.instant().toString(),
            headers: new Headers(),
          },
        ),
      )
      return (path: string, body?: object, expected = id) =>
        app.request(`${publicUrl}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: {
            cookie: session.cookie.split(';')[0] as string,
            origin: publicUrl,
            'content-type': 'application/json',
            'x-expected-organization-id': expected,
          },
          body: body ? JSON.stringify(body) : undefined,
        })
    }
    return { id, name, event, booking, owner, admin, browser }
  }

  it('preserves local access and denies each parent, child and sibling in either direction', async () => {
    const parent = await team('Parent')
    const child = await team('Child')
    const sibling = await team('Sibling')
    const { id: connectionId } = await db
      .insertInto('scim_connections')
      .values({ organization_id: parent.id })
      .returning('id')
      .executeTakeFirstOrThrow()
    for (const target of [child, sibling]) {
      await db
        .insertInto('scim_team_mappings')
        .values({
          parent_organization_id: parent.id,
          child_organization_id: target.id,
          connection_id: connectionId,
          external_id: target.name,
        })
        .execute()
    }
    const teams = [parent, child, sibling]
    const absent = randomUUID()
    for (const source of teams) {
      for (const role of ['owner', 'admin'] as const) {
        const request = await source.browser(source[role].id)
        const description = `${source.name} ${role}`
        expect((await request(`/api/v1/event-types/${source.event}`)).status, description).toBe(200)
        expect((await request(`/api/v1/team/bookings/${source.booking}`)).status, description).toBe(
          200,
        )
        for (const endpoint of ['get-full-organization', 'list-members']) {
          const response = await request(
            `${organizationPath}/${endpoint}?organizationId=${source.id}`,
          )
          expect(response.status, description).toBe(200)
          expect(await response.json()).toMatchObject({
            members: expect.arrayContaining([expect.objectContaining({ userId: source[role].id })]),
          })
        }
        const ownSettings = await request(`${organizationPath}/update`, {
          organizationId: source.id,
          data: { name: source.name },
        })
        expect(ownSettings.status, description).toBe(200)
        expect((await request('/api/v1/audit-events')).status, description).toBe(200)

        for (const target of teams.filter((candidate) => candidate !== source)) {
          const direction = `${description} → ${target.name}`
          // Better Auth can clear the session's selection after a foreign organization lookup.
          const foreign = await source.browser(source[role].id)
          for (const [resource, id] of [
            ['/api/v1/event-types', target.event],
            ['/api/v1/team/bookings', target.booking],
          ]) {
            const denied = await foreign(`${resource}/${id}`)
            const missing = await foreign(`${resource}/${absent}`)
            expect(denied.status, direction).toBe(404)
            expect(await denied.json(), direction).toEqual(await missing.json())
          }
          for (const path of ['/api/v1/team/bookings', '/api/v1/audit-events']) {
            const denied = await foreign(path, undefined, target.id)
            expect(denied.status, direction).toBe(403)
            expect(await denied.json()).toMatchObject({ error: 'team_management_access_denied' })
          }
          for (const endpoint of ['get-full-organization', 'list-members']) {
            const denied = await foreign(
              `${organizationPath}/${endpoint}?organizationId=${target.id}`,
            )
            expect(denied.status, direction).toBe(403)
            expect(await denied.json()).toMatchObject({
              code:
                endpoint === 'list-members'
                  ? 'YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION'
                  : 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION',
            })
          }
          const settings = await foreign(
            `${organizationPath}/update`,
            { organizationId: target.id, data: { name: 'Unauthorized rename' } },
            target.id,
          )
          expect(settings.status, direction).toBe(403)
          expect(await settings.json()).toMatchObject({ code: 'TEAM_MANAGEMENT_ACCESS_DENIED' })
        }
      }
    }
    expect(
      await db
        .selectFrom('auth.organization')
        .select('name')
        .where(
          'id',
          'in',
          teams.map(({ id }) => id),
        )
        .orderBy('name')
        .execute(),
    ).toEqual([{ name: 'Child' }, { name: 'Parent' }, { name: 'Sibling' }])
  })
})
