import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const secret = 'synthetic-native-delete-test-secret-only-00000'
const signup = { mode: 'open', allowedDomains: [] } as const

describe.skipIf(!databaseUrl)('Native organization deletion and SCIM team links', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>
  let app: ReturnType<typeof createApp>
  let resourceApp: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, {
      tag: 'scim_org_delete',
    })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, signup)
    app = instance(false)
    resourceApp = instance(true)
  })

  function instance(scimResourcesEnabled: boolean) {
    const auth = createAuth({
      db,
      pool,
      signup,
      secret,
      baseURL: publicUrl,
      scimResourcesEnabled,
      mailer: { send: async () => expect.unreachable('Deletion does not send mail') },
    })
    return createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: [],
    })
  }

  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function team() {
    const owner = await createTestUser(db)
    const { id } = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const session = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { publicUrl, secret },
        {
          userId: owner.id,
          organizationId: id,
          now: Temporal.Now.instant().toString(),
          headers: new Headers(),
        },
      ),
    )
    return { id, cookie: session.cookie.split(';')[0] as string }
  }

  function deleteTeam({ id, cookie }: Awaited<ReturnType<typeof team>>, server = app) {
    return server.request(`${publicUrl}/api/auth/organization/delete`, {
      method: 'POST',
      headers: { cookie, origin: publicUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: id }),
    })
  }

  it('pins the response and SQL statement count for ordinary unlinked team deletion', async () => {
    const ordinary = await team()
    const queries = vi.spyOn(pg.Client.prototype, 'query')
    try {
      const response = await deleteTeam(ordinary)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        code: 'TEAM_OPERATION_NOT_SUPPORTED',
        message: 'Deleting a team is not supported.',
      })
      expect(queries.mock.calls.length).toBe(0)
    } finally {
      queries.mockRestore()
    }
  })

  it('refuses native deletion from both ends of a live mapping and keeps both rosters', async () => {
    const parent = await team()
    const child = await team()
    const { id: connectionId } = await db
      .insertInto('scim_connections')
      .values({ organization_id: parent.id })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('scim_team_mappings')
      .values({
        parent_organization_id: parent.id,
        child_organization_id: child.id,
        connection_id: connectionId,
        external_id: 'Synthetic-Group',
      })
      .execute()
    for (const endpoint of [parent, child]) {
      const response = await deleteTeam(endpoint, resourceApp)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        code: 'SCIM_MAPPING_DETACH_REQUIRED',
        message: 'Detach the team’s SCIM mapping links before deleting it.',
      })
      const members = await db
        .selectFrom('auth.member')
        .select('role')
        .where('organizationId', '=', endpoint.id)
        .execute()
      expect(members).toEqual([{ role: 'owner' }])
    }
    const unrelated = await team()
    expect((await deleteTeam({ ...child, cookie: unrelated.cookie }, resourceApp)).status).toBe(403)
    expect((await deleteTeam(unrelated, resourceApp)).status).toBe(403)
  })
})
