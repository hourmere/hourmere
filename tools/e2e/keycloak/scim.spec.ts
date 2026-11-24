import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { OpenAPIHono } from '@hono/zod-openapi'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { test as base, expect } from '@playwright/test'
import { mountScim } from '../../../apps/server/src/scim.ts'
import { scimDiscoveryWithGroups } from '../../../apps/server/src/scim-discovery.ts'
import { scimGroups } from '../../../apps/server/src/scim-groups.ts'
import { scimUserCreation } from '../../../apps/server/src/scim-user-create.ts'
import { scimUserReplacement } from '../../../apps/server/src/scim-user-replace.ts'
import { scimUsers } from '../../../apps/server/src/scim-users.ts'
import { listenOwned } from '../listeners.ts'
import { startKeycloak } from './keycloak.ts'
import { createScimCapture } from './scim-capture.ts'

const person = {
  username: 'scim-alex@example.test',
  email: 'scim-alex@example.test',
  firstName: 'Alex',
  lastName: 'Fixture',
}
const renamedPerson = 'Avery'
const initialGroup = 'Initial SCIM group'
const groupName = 'SCIM fixture group'
const renamedGroup = 'Renamed SCIM fixture group'

function scimApp(db: Db, origin: string) {
  const app = new OpenAPIHono()
  const groups = scimGroups(db)
  const create = scimUserCreation({
    db,
    signup: { mode: 'closed', allowedDomains: ['example.test'] },
  })
  const replace = scimUserReplacement(db)
  const read = scimUsers(db)
  mountScim(
    app,
    {
      db,
      enabled: true,
      resources: (request) =>
        scimDiscoveryWithGroups(request) ??
        groups(request) ??
        create(request) ??
        replace(request) ??
        read(request),
    },
    [],
    origin,
  )
  return app
}

async function seedDirectory(db: Db) {
  const fixture = createFixtures(db)
  const organizationId = await fixture.organization()
  const childId = await fixture.organization()
  await fixture.member(await fixture.user('SCIM fixture owner'), organizationId, 'owner')
  const credential = `scim_${randomBytes(32).toString('base64url')}`
  const token = await db
    .insertInto('scim_provisioning_tokens')
    .values({
      organization_id: organizationId,
      name: 'Keycloak SCIM fixture',
      token_hash: createHash('sha256').update(credential).digest('base64url'),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const { connection_id: connectionId } = await db
    .selectFrom('scim_token_connections')
    .select('connection_id')
    .where('token_id', '=', token.id)
    .executeTakeFirstOrThrow()
  return { organizationId, childId, connectionId, credential }
}

const test = base.extend<object, { keycloak: Awaited<ReturnType<typeof startKeycloak>> }>({
  keycloak: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructuring fixture dependencies.
    async ({}, use) => {
      const container = await startKeycloak({ scim: true })
      try {
        await use(container)
      } finally {
        await container.close()
      }
    },
    { scope: 'worker' },
  ],
})

test('captures Keycloak outbound SCIM Users and Groups', async ({ keycloak }) => {
  const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
  if (!bootstrap) throw new Error('Keycloak SCIM requires HOURMERE_E2E_BOOTSTRAP_URL')
  const owned = await createTestDatabase(bootstrap, undefined, { tag: 'keycloak_scim' })
  const capture = createScimCapture([
    ...Object.values(person),
    `${person.firstName} ${person.lastName}`,
    renamedPerson,
    `${renamedPerson} ${person.lastName}`,
    groupName,
    renamedGroup,
  ])
  const seen = (entry: Record<string, unknown>) =>
    expect.poll(() => capture.entries).toContainEqual(expect.objectContaining(entry))

  try {
    const db = createDb(owned.pool)
    const { organizationId, childId, connectionId, credential } = await seedDirectory(db)
    const listener = await listenOwned(createServer())
    try {
      const origin = `http://${keycloak.scimTargetHost}:${listener.port}`
      const app = scimApp(db, origin)
      listener.server.on(
        'request',
        getRequestListener((request) => capture.fetch(request, app.fetch), {
          hostname: keycloak.scimTargetHost,
        }),
      )
      const realm = await keycloak.createScimRealm()
      try {
        // Keycloak assigns the external ID. Hourmere only provisions reserved Groups.
        const groupId = await realm.createGroup(initialGroup)
        await db
          .insertInto('scim_team_mappings')
          .values({
            parent_organization_id: organizationId,
            child_organization_id: childId,
            connection_id: connectionId,
            external_id: groupId,
          })
          .execute()
        await realm.configureTarget(`${origin}/scim/v2/${organizationId}`, credential)

        const userId = await realm.createUser(person)
        await seen({
          method: 'POST',
          path: '/Users',
          status: 201,
          response: expect.objectContaining({ userName: person.username, active: true }),
        })
        await realm.updateUser(userId, { firstName: renamedPerson })
        await seen({
          method: 'PATCH',
          path: expect.stringMatching(/^\/Users\//),
          status: 200,
          response: expect.objectContaining({
            name: expect.objectContaining({ givenName: renamedPerson }),
          }),
        })
        await realm.updateUser(userId, { enabled: false })
        await seen({
          method: 'PATCH',
          path: expect.stringMatching(/^\/Users\//),
          request: expect.objectContaining({
            Operations: expect.arrayContaining([{ op: 'replace', path: 'active', value: false }]),
          }),
          status: 200,
          response: expect.objectContaining({ active: false }),
        })

        await realm.updateGroup(groupId, groupName)
        await seen({
          method: 'POST',
          path: '/Groups',
          status: 201,
          response: expect.objectContaining({ displayName: groupName }),
        })
        await realm.updateGroup(groupId, renamedGroup)
        await seen({
          method: 'PATCH',
          path: expect.stringMatching(/^\/Groups\//),
          status: 200,
          response: expect.objectContaining({ displayName: renamedGroup }),
        })

        await seen({
          method: 'GET',
          path: '/ServiceProviderConfig',
          status: 200,
          response: expect.objectContaining({ patch: { supported: true } }),
        })
        await seen({
          method: 'GET',
          path: '/Users',
          query: expect.objectContaining({ filter: `userName eq "${person.username}"` }),
          status: 200,
        })
        await seen({
          method: 'GET',
          path: '/Groups',
          query: expect.objectContaining({ filter: `displayName eq "${groupName}"` }),
          status: 200,
        })
        expect(
          capture.entries.filter(({ method }) => method === 'PUT' || method === 'DELETE'),
        ).toEqual([])

        const denied = await app.request(`${origin}/scim/v2/${childId}/Users`, {
          headers: { authorization: `Bearer ${credential}` },
        })
        expect(denied.status).toBe(401)
        const user = await db
          .selectFrom('scim_users')
          .select(['active', 'external_id', 'linked_user_id'])
          .where('organization_id', '=', organizationId)
          .executeTakeFirstOrThrow()
        expect(user).toEqual({ active: false, external_id: userId, linked_user_id: null })
      } finally {
        await realm.close()
      }
    } finally {
      await listener.close()
    }
  } finally {
    // Only the capture's allowlisted projection reaches the reporter, including on failures.
    for (const entry of capture.entries) console.log(JSON.stringify(entry))
    await owned.drop()
  }
})
