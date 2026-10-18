import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEventType, updateEventType } from './event-types.ts'
import { createTestTeam, createTestUser, type TestUser } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('automatic Zoom connection settings parity (real Postgres)', () => {
  let database: TestDatabase,
    db: Db,
    owner: TestUser,
    other: TestUser,
    connectionId: string,
    otherConnectionId: string
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
    owner = await createTestUser(db)
    other = await createTestUser(db)
    for (const user of [owner, other]) {
      const connection = await db
        .insertInto('conference_connections')
        .values({
          user_id: user.id,
          provider: 'zoom',
          mode: 'meetings',
          external_user_id: `synthetic-${user.id}`,
          status: 'active',
          credentials: Buffer.from('synthetic'),
          scopes: [
            'user:read:user',
            'meeting:write:meeting',
            'meeting:read:meeting',
            'meeting:update:meeting',
            'meeting:delete:meeting',
          ],
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      if (user === owner) connectionId = connection.id
      else otherConnectionId = connection.id
    }
  })
  afterAll(async () => {
    await database?.drop()
  })
  const context = (principal: Principal) => ({
    db,
    principal,
    automaticZoom: true,
    now: () => Temporal.Now.instant(),
  })
  const input = (connection = connectionId) => ({
    slug: `zoom-${randomUUID()}`,
    title: 'Zoom configuration',
    durationMinutes: 30,
    location: { kind: 'zoom' as const, autoCreate: true as const },
    zoomConnectionId: connection,
  })
  it.each(['session', 'api_key', 'oauth'] as const)(
    'allows the actual host to select and replace their connection as %s',
    async (kind) => {
      const principal: Principal =
        kind === 'session'
          ? {
              ...owner.principal,
              kind,
              sessionId: (
                await db
                  .insertInto('auth.session')
                  .values({
                    userId: owner.id,
                    token: randomUUID(),
                    updatedAt: new Date(),
                    expiresAt: new Date(Date.now() + 86400000),
                  })
                  .returning('id')
                  .executeTakeFirstOrThrow()
              ).id,
            }
          : kind === 'api_key'
            ? owner.principal
            : {
                user: owner.principal.user,
                organization: owner.principal.organization,
                kind,
                clientId: 'synthetic-client',
                oauthConsentId: 'synthetic-consent',
                scopes: ['mcp:tools'],
              }
      const creating = createEventType(context(principal), input())
      await expect(creating).resolves.toMatchObject({ zoomConnectionId: connectionId })
      const created = await creating
      expect(created.zoomConnectionId).toBe(connectionId)
      await updateEventType(context(principal), created.id, {
        location: { kind: 'zoom' },
        zoomConnectionId: null,
      })
      const updated = await updateEventType(context(principal), created.id, {
        location: { kind: 'zoom', autoCreate: true },
        zoomConnectionId: connectionId,
      })
      expect(updated).toMatchObject({
        zoomConnectionId: connectionId,
        location: { kind: 'zoom', autoCreate: true },
      })
    },
  )
  it('rejects another user connection even when the actor is the event host', async () => {
    await expect(
      createEventType(context(owner.principal), input(otherConnectionId)),
    ).rejects.toMatchObject({ code: 'automatic_zoom_unavailable' })
  })
  it('rejects a team administrator selecting the actual host private connection', async () => {
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: other, role: 'admin' },
    ])
    await expect(
      createEventType(context(team.as(other)), { ...input(), hosts: [{ userId: owner.id }] }),
    ).rejects.toMatchObject({ code: 'zoom_host_session_required' })
  })
  it('keeps event selection in the key acting organization even for an owner of both organizations', async () => {
    const first = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const second = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const event = await createEventType(context(first.as(owner)), input())
    await expect(
      updateEventType(context(second.as(owner)), event.id, {
        location: { kind: 'zoom' },
        zoomConnectionId: null,
      }),
    ).rejects.toMatchObject({ code: 'event_type_not_found' })
  })
})
