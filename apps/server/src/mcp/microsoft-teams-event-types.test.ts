import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import { eventTypeRoutes } from '../routes/event-types.ts'
import { mcpEndpoint } from './endpoint.ts'
import { eventTypeTools } from './event-types.ts'

const apiKey = 'hm_synthetic'
const publicUrl = 'http://localhost:4189'
const location = { kind: 'microsoft_teams' }
const teamsOption = { id: 'teams', ...location }
const input = () => ({
  slug: `teams-${randomUUID()}`,
  title: 'Microsoft Teams consultation',
  durationMinutes: 30,
})

describe.skipIf(!process.env.DATABASE_URL)('Microsoft Teams event type configuration', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'teams_config',
    })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function destination(userId: string, scopes: string[]) {
    const { id: connectionId } = await db
      .insertInto('calendar_connections')
      .values({
        user_id: userId,
        provider: 'microsoft',
        external_account_id: randomUUID(),
        credentials: Buffer.from('synthetic-never-used-credential'),
        scopes,
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { id: calendarId } = await db
      .insertInto('calendars')
      .values({
        connection_id: connectionId,
        external_id: randomUUID(),
        name: 'Calendar for booking events',
        access_role: 'owner',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('profiles')
      .values({
        user_id: userId,
        handle: `host-${randomUUID().slice(0, 12)}`,
        time_zone: 'UTC',
        destination_calendar_id: calendarId,
      })
      .execute()
    return { calendarId, connectionId }
  }

  function clients(principal: Principal) {
    const deps = { db, microsoftCalendarEnabled: true }
    const app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
      routes: [eventTypeRoutes(deps)],
      mcp: mcpEndpoint({ tools: eventTypeTools(deps) }),
    })
    const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
    return {
      async rest(changes: object, id?: string) {
        const response = await app.request(
          id ? `/api/v1/event-types/${id}` : '/api/v1/event-types',
          { method: id ? 'PATCH' : 'POST', headers, body: JSON.stringify(changes) },
        )
        return { status: response.status, body: (await response.json()) as { id: string } }
      },
      async mcp(changes: object, id?: string) {
        const response = await app.request('/mcp', {
          method: 'POST',
          headers: { ...headers, accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: id ? 'update_event_type' : 'create_event_type',
              arguments: { ...changes, ...(id && { id }) },
            },
          }),
        })
        expect(response.status).toBe(200)
        const text = await response.text()
        const json = response.headers.get('content-type')?.startsWith('text/event-stream')
          ? text
              .split('\n')
              .find((line) => line.startsWith('data: '))
              ?.slice(6)
          : text
        const result = JSON.parse(json ?? 'null').result
        expect(result).toBeDefined()
        return {
          isError: result.isError === true,
          body: result.structuredContent ?? JSON.parse(result.content[0].text),
        }
      },
      async cli(changes: object, id?: string) {
        let output = ''
        let error = ''
        const code = await runCli({
          argv: [id ? 'update-event' : 'create-event', '--input', '-'],
          env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: apiKey },
          stdin: (async function* () {
            yield JSON.stringify({ ...changes, ...(id && { id }) })
          })(),
          stdout: (text) => {
            output += text
          },
          stderr: (text) => {
            error += text
          },
          fetch: async (request, init) => app.request(request, init),
        })
        return { code, body: JSON.parse(output || error) }
      },
    }
  }

  async function denied(
    client: ReturnType<typeof clients>,
    changes: object,
    status: number,
    error: string,
    id?: string,
  ) {
    expect(await client.rest(changes, id)).toMatchObject({ status, body: { error } })
    expect(await client.mcp(changes, id)).toMatchObject({ isError: true, body: { error } })
    expect(await client.cli(changes, id)).toMatchObject({ code: 1, body: { error } })
  }

  it('requires a selected writable Microsoft calendar and preserves both location inputs', async () => {
    const host = await createTestUser(db)
    const client = clients(host.principal)
    const changes = { ...input(), location }
    await denied(client, changes, 409, 'microsoft_teams_calendar_unavailable')
    const { connectionId } = await destination(host.id, ['Calendars.Read'])
    await denied(client, changes, 409, 'microsoft_teams_calendar_unavailable')
    await db
      .updateTable('calendar_connections')
      .set({ scopes: ['Calendars.ReadWrite'] })
      .where('id', '=', connectionId)
      .execute()

    const created = await client.rest(changes)
    expect(created).toMatchObject({ status: 201, body: { location } })
    const saved = { location, locations: [teamsOption] }
    expect(await client.mcp({ locations: [teamsOption] }, created.body.id)).toMatchObject({
      isError: false,
      body: saved,
    })
    expect(await client.cli({ locations: [teamsOption] }, created.body.id)).toMatchObject({
      code: 0,
      body: saved,
    })
    await denied(
      client,
      { location: { ...location, url: 'https://teams.microsoft.com/unauthorized' } },
      400,
      'invalid_request',
      created.body.id,
    )
    await denied(
      client,
      { locations: [{ ...teamsOption, status: 'ready' }] },
      400,
      'invalid_request',
      created.body.id,
    )
  })

  it('preserves team roles, key scopes and host ownership across REST, MCP and CLI', async () => {
    const owner = await createTestUser(db)
    const host = await createTestUser(db)
    const outsider = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: host, role: 'member' },
    ])
    const hostCalendar = await destination(host.id, ['Calendars.ReadWrite'])
    const ownerPrincipal = team.as(owner)
    const ownerClient = clients(ownerPrincipal)
    const ownerHosts = [{ userId: owner.id }]
    const hostOnly = [{ userId: host.id }]
    const changes = { ...input(), locations: [teamsOption] }
    await denied(
      ownerClient,
      { ...changes, schedulingType: 'collective', hosts: [...ownerHosts, ...hostOnly] },
      400,
      'microsoft_teams_host_policy',
    )
    await denied(
      ownerClient,
      { ...changes, schedulingType: 'round_robin', hosts: hostOnly },
      400,
      'microsoft_teams_host_policy',
    )
    await denied(
      ownerClient,
      { ...changes, hosts: [{ userId: outsider.id }] },
      400,
      'invalid_hosts',
    )
    await db
      .insertInto('profiles')
      .values({
        user_id: owner.id,
        handle: `host-${randomUUID().slice(0, 12)}`,
        time_zone: 'UTC',
        destination_calendar_id: hostCalendar.calendarId,
      })
      .execute()
    await denied(
      ownerClient,
      { ...changes, hosts: ownerHosts },
      409,
      'microsoft_teams_calendar_unavailable',
    )
    await denied(clients(team.as(host)), changes, 403, 'insufficient_role')
    if (ownerPrincipal.kind !== 'api_key') throw new Error('Expected test API key')
    for (const apiKeyScope of ['read', 'bookings'] as const) {
      await denied(
        clients({ ...ownerPrincipal, apiKeyScope }),
        { ...changes, hosts: hostOnly },
        403,
        'insufficient_scope',
      )
    }
    const created = await ownerClient.cli({ ...changes, hosts: hostOnly })
    expect(created).toMatchObject({ code: 0, body: { location, locations: [teamsOption] } })
    await denied(
      clients(outsider.principal),
      { locations: null },
      404,
      'event_type_not_found',
      created.body.id,
    )
    expect(await ownerClient.mcp({ title: 'Ready for Teams' }, created.body.id)).toMatchObject({
      isError: false,
      body: { location, title: 'Ready for Teams' },
    })
  })
})
