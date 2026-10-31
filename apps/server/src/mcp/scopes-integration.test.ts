// Real persisted scopes and booking services over JSON-RPC, with bounded shared pools.
import { randomBytes, randomUUID } from 'node:crypto'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { productTools } from '../server.ts'
import { mcpEndpoint } from './endpoint.ts'

const scopes = ['full', 'read', 'bookings'] as const
const publicUrl = 'http://localhost:4185'
const denied = {
  error: 'insufficient_scope',
  message: 'This API key does not allow this operation.',
}
type Key = { id: string; key: string }
type Data = {
  principal: { apiKeyScope: string; apiKeyId: string }
  organization: { id: string }
  handle: string
  id: string
  data: { id: string }[]
  slots: { start: string }[]
  booking: { id: string; source: string; rescheduledFromId: string | null }
  manageToken: string
  status: string
}
type Result = { isError?: boolean; structuredContent?: Data; content: { text: string }[] }

describe.skipIf(!process.env.DATABASE_URL)('MCP persisted scope matrix', () => {
  let database: TestDatabase
  let db: Db
  let pool: pg.Pool
  let auth: Auth
  let fixtures: Fixtures
  let host: Awaited<ReturnType<Fixtures['host']>>
  let schedule: string
  let personalEvent: string
  let teamEvent: string
  let team: string
  let app: ReturnType<typeof createApp>
  const keys = new Map<string, Key>()
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    pool = createAuthPool(database.url, signup)
    auth = createAuth({
      pool,
      db,
      baseURL: publicUrl,
      secret: randomBytes(32).toString('base64'),
      mailer: {
        send: async () => {
          throw Error('No mail may be delivered by scope tests')
        },
      },
      signup,
    })
    fixtures = createFixtures(db)
    host = await fixtures.host({ handle: 'mcp-scoped-host' })
    schedule = await fixtures.schedule(host.userId)
    personalEvent = await fixtures.eventType(host.organizationId, host.userId, { slug: 'intro' })
    team = await fixtures.organization('mcp-scoped-team')
    await fixtures.member(host.userId, team, 'owner')
    teamEvent = await fixtures.eventType(team, null, {
      slug: 'intro',
      hosts: [{ userId: host.userId }],
    })
    for (const scope of scopes) {
      for (const [space, organizationId] of [
        ['personal', host.organizationId],
        ['team', team],
      ]) {
        keys.set(
          `${scope}:${space}`,
          await auth.api.createApiKey({
            body: { userId: host.userId, metadata: { scope, organizationId } },
          }),
        )
      }
    }
    app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl,
      mcp: mcpEndpoint({ tools: productTools({ db }) }),
    })
  })
  afterAll(async () => {
    await pool?.end()
    await database?.drop()
  })
  async function rpc(key: Key, method: string, params: Record<string, unknown> = {}) {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const text = await res.text()
    const data = text.split('\n').find((line) => line.startsWith('data: '))
    return { res, message: JSON.parse(data ? data.slice(6) : text) }
  }
  async function call(key: Key, name: string, args: Record<string, unknown> = {}): Promise<Result> {
    const { res, message } = await rpc(key, 'tools/call', { name, arguments: args })
    expect(res.status).toBe(200)
    return message.result
  }
  function success(result: Result) {
    expect(result.isError).toBeFalsy()
    return result.structuredContent as Data
  }
  function failure(result: Result) {
    expect(result.isError).toBe(true)
    return JSON.parse(result.content[0]?.text ?? '')
  }

  it.each(scopes)('%s keeps personal/team reads and credential attribution', async (scope) => {
    for (const [space, organizationId, event] of [
      ['personal', host.organizationId, personalEvent],
      ['team', team, teamEvent],
    ] as const) {
      const key = keys.get(`${scope}:${space}`) as Key
      const identity = success(await call(key, 'whoami'))
      expect(identity.principal).toMatchObject({ apiKeyScope: scope, apiKeyId: key.id })
      expect(identity.organization.id).toBe(organizationId)
      expect(success(await call(key, 'get_profile')).handle).toBe('mcp-scoped-host')
      expect(
        success(await call(key, 'list_event_types')).data.map((row: { id: string }) => row.id),
      ).toEqual([event])
      expect(success(await call(key, 'get_event_type', { id: event })).id).toBe(event)
      expect(success(await call(key, 'list_bookings')).data).toEqual([])
      for (const [name, args] of [
        ['list_schedules', {}],
        ['get_schedule', { id: schedule }],
        ['list_calendar_connections', {}],
        ['list_conference_connections', {}],
      ] as const) {
        const result = await call(key, name, args)
        if (scope === 'bookings') expect(failure(result)).toEqual(denied)
        else success(result)
      }
    }
  })

  it.each(scopes)(
    '%s checks personal/team create and host/manage writes with real bookings',
    async (scope) => {
      for (const space of ['personal', 'team'] as const) {
        const key = keys.get(`${scope}:${space}`) as Key
        const target =
          space === 'personal' ? { handle: 'mcp-scoped-host' } : { teamSlug: 'mcp-scoped-team' }
        const args = {
          ...target,
          slug: 'intro',
          startDate: '2026-11-02',
          endDate: '2026-11-02',
          timeZone: 'Europe/Berlin',
        }
        const slots = success(await call(key, 'find_available_slots', args)).slots
        expect(slots.length).toBeGreaterThan(2)
        const [first, next] = slots
        if (!first || !next) throw Error('Expected at least two available slots')
        const book = {
          ...target,
          slug: 'intro',
          start: first.start,
          idempotencyKey: randomUUID(),
          invitee: {
            name: 'Scope invitee',
            email: 'scope@example.test',
            timeZone: 'Europe/Berlin',
          },
        }
        if (scope === 'read') {
          const before = await db.selectFrom('bookings').select('id').execute()
          expect(failure(await call(key, 'create_booking', book))).toEqual(denied)
          for (const name of ['cancel_booking', 'reschedule_booking']) {
            for (const identity of [{ bookingId: randomUUID() }, { manageToken: 'invalid' }])
              expect(failure(await call(key, name, { ...identity, start: next.start }))).toEqual(
                denied,
              )
          }
          for (const name of ['retry_conference', 'retry_calendar_copy'])
            expect(failure(await call(key, name, { bookingId: randomUUID() }))).toEqual(denied)
          expect(await db.selectFrom('bookings').select('id').execute()).toEqual(before)
          continue
        }
        for (const mode of ['host', 'manageToken'] as const) {
          const created = success(
            await call(key, 'create_booking', { ...book, idempotencyKey: randomUUID() }),
          )
          expect(created.booking.source).toBe('mcp')
          const identity =
            mode === 'host'
              ? { bookingId: created.booking.id }
              : { manageToken: created.manageToken }
          const moved = success(
            await call(key, 'reschedule_booking', { ...identity, start: next.start }),
          )
          expect(moved.booking.rescheduledFromId).toBe(created.booking.id)
          const cancellation =
            mode === 'host' ? { bookingId: moved.booking.id } : { manageToken: moved.manageToken }
          expect(success(await call(key, 'cancel_booking', cancellation)).status).toBe('cancelled')
        }
        // These retries pass scope and retain existing resource checks.
        for (const name of ['retry_conference', 'retry_calendar_copy'])
          expect(failure(await call(key, name, { bookingId: randomUUID() })).error).toBe(
            name === 'retry_conference' ? 'conference_not_found' : 'calendar_copy_not_found',
          )
      }
    },
  )

  it.each(scopes)(
    '%s revalidates disabled, expired, deleted and departed-team keys before list/call',
    async (scope) => {
      for (const invalidation of ['disabled', 'expired', 'deleted', 'membership'] as const) {
        const organizationId =
          invalidation === 'membership'
            ? await fixtures.organization(`scope-departed-${randomUUID().slice(0, 8)}`)
            : host.organizationId
        if (invalidation === 'membership') await fixtures.member(host.userId, organizationId)
        const key = await auth.api.createApiKey({
          body: { userId: host.userId, metadata: { scope, organizationId } },
        })
        expect((await rpc(key, 'tools/list')).res.status).toBe(200)
        if (invalidation === 'disabled')
          await auth.api.updateApiKey({
            body: { userId: host.userId, keyId: key.id, enabled: false },
          })
        else if (invalidation === 'expired')
          await pool.query('UPDATE auth.apikey SET "expiresAt" = now() WHERE id = $1', [key.id])
        else if (invalidation === 'deleted')
          await pool.query('DELETE FROM auth.apikey WHERE id = $1', [key.id])
        else
          await pool.query(
            'DELETE FROM auth.member WHERE "userId" = $1 AND "organizationId" = $2',
            [host.userId, organizationId],
          )
        for (const [method, params] of [
          ['tools/list', {}],
          ['tools/call', { name: 'whoami', arguments: {} }],
        ] as const) {
          const { res, message } = await rpc(key, method, params)
          expect(res.status).toBe(401)
          expect(message.error).toBe('unauthorized')
          expect(res.headers.get('www-authenticate')).toContain('invalid_token')
          expect(res.headers.get('cache-control')).toBe('no-store')
        }
      }
    },
  )
})
