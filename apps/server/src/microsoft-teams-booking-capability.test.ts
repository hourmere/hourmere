import { randomUUID } from 'node:crypto'
import { createMicrosoftCalendarClient } from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { productRoutes, productTools } from './server.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'http://localhost'
const apiKey = 'hm_synthetic'
const handle = 'teams-capability-host'
const slug = 'teams-capability-event'
const location = { kind: 'microsoft_teams' }

describe.skipIf(!serverUrl)('Microsoft Teams booking capability', () => {
  let owned: TestDatabase
  let db: Db
  let host: TestUser
  let eventTypeId: string

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    host = await createTestUser(db)
    const fixtures = createFixtures(db)
    await fixtures.schedule(host.id, { timeZone: 'UTC' })
    const { calendarId } = await fixtures.calendarBusy(host.id, [], { checkConflicts: false })
    await db
      .updateTable('calendar_connections')
      .set({ status: 'active', scopes: ['Calendars.ReadWrite'] })
      .where('user_id', '=', host.id)
      .execute()
    await db
      .updateTable('calendars')
      .set({ access_role: 'owner' })
      .where('id', '=', calendarId)
      .execute()
    await db
      .insertInto('profiles')
      .values({ user_id: host.id, handle, time_zone: 'UTC', destination_calendar_id: calendarId })
      .execute()
    eventTypeId = await fixtures.eventType(host.principal.organization.id, host.id, {
      slug,
      location,
    })
  })

  afterAll(async () => owned?.drop())

  const providerRequest = vi.fn(async () => {
    throw new Error('Booking capability must be decided without a Microsoft request')
  })
  function app(enabled: boolean) {
    const microsoftCalendar = enabled
      ? {
          client: createMicrosoftCalendarClient(
            { clientId: 'synthetic', clientSecret: 'synthetic', publicUrl },
            providerRequest,
          ),
          encryptionKey: 'synthetic',
        }
      : undefined
    return createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: true, principal: host.principal, setCookie: [] }),
      routes: productRoutes({
        db,
        microsoftCalendar,
        socialProviders: {},
        invitationMailLimits: { secret: 'synthetic' },
      }),
      mcp: mcpEndpoint({ tools: productTools({ db, microsoftCalendar }) }),
    })
  }

  it('refuses new Teams bookings through REST and CLI when Microsoft calendars are off', async () => {
    const today = Temporal.Now.plainDateISO('UTC')
    const monday = today.add({ days: 8 - today.dayOfWeek })
    const input = {
      start: `${monday}T09:00:00Z`,
      invitee: { name: 'Invitee', email: 'invitee@example.test', timeZone: 'UTC' },
    }
    const rest = (target: ReturnType<typeof app>) =>
      target.request(`/api/v1/public/${handle}/${slug}/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
    async function cli(target: ReturnType<typeof app>) {
      let output = ''
      let error = ''
      const code = await runCli({
        argv: ['book', '--input', '-'],
        env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: apiKey },
        stdin: (async function* () {
          yield JSON.stringify({
            ...input,
            handle,
            slug,
            start: `${monday}T10:00:00Z`,
            idempotencyKey: randomUUID(),
          })
        })(),
        stdout: (text) => {
          output += text
        },
        stderr: (text) => {
          error += text
        },
        fetch: async (request, init) => target.request(request, init),
      })
      return { code, body: JSON.parse(output || error) }
    }

    const disabled = app(false)
    const refusal = await rest(disabled)
    expect(refusal.status).toBe(409)
    expect(await refusal.json()).toMatchObject({ error: 'location_unavailable' })
    expect(await cli(disabled)).toMatchObject({ code: 1, body: { error: 'location_unavailable' } })
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', eventTypeId)
        .execute(),
    ).toEqual([])

    const enabled = app(true)
    const accepted = await rest(enabled)
    expect(accepted.status).toBe(201)
    expect(await accepted.json()).toMatchObject({ booking: { status: 'confirmed', location } })
    expect(await cli(enabled)).toMatchObject({
      code: 0,
      body: { booking: { status: 'confirmed', location } },
    })
    expect(providerRequest).not.toHaveBeenCalled()
  })
})
