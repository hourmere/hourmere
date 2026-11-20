// Pins which MCP tools pass the team SSO proof check, and proves each gated one refuses.
import { randomBytes } from 'node:crypto'
import {
  API_KEY_MCP_OPERATIONS,
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DomainError } from '@hourmere/scheduling/errors'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from '../app.ts'
import { productTools } from '../server.ts'
import { teamWriteTool } from '../sso-write-routes.ts'
import { mcpEndpoint, teamReadTool } from './endpoint.ts'
import type { Tool } from './tools.ts'

const publicUrl = 'http://localhost:4391'
const webhooks = { enabled: true, encryptionKey: randomBytes(32).toString('base64') }

/**
 * Every MCP operation that does not pass the team proof check, with the reason. Keep this
 * list explicit: a new tool that is neither gated nor listed here fails the manifest test,
 * so its classification is reviewed against docs/sso.md ("Team enforcement" and "Team
 * write enforcement"). MCP has no enrollment-exception tools (link and unlink are REST only).
 */
const ungated: Record<string, string> = {
  'mcp:read_meeting_poll': 'capability link: voter reads a poll through its public link',
  'mcp:enroll_meeting_poll_voter': 'capability link: public poll enrollment',
  'mcp:recover_meeting_poll_voter': 'capability link: public poll voter recovery',
  'mcp:verify_meeting_poll_voter': 'capability link: public poll voter verification',
  'mcp:submit_meeting_poll_vote': 'capability link: public poll vote',
  'mcp:withdraw_meeting_poll_vote': 'capability link: public poll vote withdrawal',
  'mcp:opt_out_meeting_poll_reminder': 'capability link: public poll reminder opt-out',
  'mcp:get_public_routing_form': 'public: published routing form',
  'mcp:route_lead': 'public: published routing form submission',
  'mcp:find_available_slots:personal': 'public: personal booking page slots',
  'mcp:find_available_slots:team': 'public: team booking page slots',
  'mcp:create_booking:personal': 'public: personal booking page',
  'mcp:create_booking:team': 'public: team booking page',
  'mcp:create_booking:oneTimeLink': 'capability link: one-time booking link',
  'mcp:reschedule_booking:manageToken': 'capability link: invitee manage token',
  'mcp:cancel_booking:manageToken': 'capability link: invitee manage token',
  'mcp:join_waitlist:personal': 'public: personal booking page waitlist',
  'mcp:join_waitlist:team': 'public: team booking page waitlist',
  'mcp:resend_waitlist_verification:personal': 'public: personal booking page waitlist',
  'mcp:resend_waitlist_verification:team': 'public: team booking page waitlist',
  'mcp:get_profile': 'personal account: the caller’s own profile',
  'mcp:list_schedules': 'personal account: schedules belong to the user',
  'mcp:get_schedule': 'personal account: schedules belong to the user',
  'mcp:get_schedule_availability': 'personal account: schedules belong to the user',
  'mcp:save_schedule_availability': 'personal account: schedules belong to the user',
  'mcp:list_calendar_connections': 'personal account: calendar connections belong to the user',
  'mcp:list_conference_connections': 'personal account: conference connections belong to the user',
}

type Gate = 'write' | 'read' | 'none'
interface Unit {
  id: string
  tool: string
  mode: string | undefined
  gate: Gate
}

/** The production catalog with every optional tool group registered. */
function catalog(db: Db) {
  return productTools({
    db,
    webhooks,
    slotSnippetsEnabled: true,
    routingFormsEnabled: true,
    publicUrl,
    waitlistSecret: 'test-secret',
    meetingPollSecret: 'test-secret',
    routingSecret: 'test-secret',
  })
}

/**
 * One unit per tool, or per scope mode for tools whose calls select a mode: runTool asks the
 * write gate with the selected mode and the read gate with the tool name.
 */
function units(tools: readonly Tool[]): Unit[] {
  return tools.flatMap((tool) =>
    (tool.scopeModes ?? [undefined]).map((mode) => ({
      id: mode === undefined ? `mcp:${tool.name}` : `mcp:${tool.name}:${mode}`,
      tool: tool.name,
      mode,
      gate: teamWriteTool(tool.name, mode)
        ? ('write' as const)
        : teamReadTool(tool.name)
          ? ('read' as const)
          : ('none' as const),
    })),
  )
}

it('classifies every registered MCP tool and mode as gated or as a listed exception', () => {
  const all = units(catalog({} as Db))
  const catalogIds = new Set(API_KEY_MCP_OPERATIONS.map((operation) => operation.id))
  for (const unit of all) expect(catalogIds, unit.id).toContain(unit.id)
  // Fails for a new unclassified tool, a listed tool that became gated, and a stale entry.
  expect(
    all
      .filter((unit) => unit.gate === 'none')
      .map((unit) => unit.id)
      .sort(),
  ).toEqual(Object.keys(ungated).sort())
  for (const reason of Object.values(ungated))
    expect(reason).toMatch(/^(public|capability link|personal account): /)
  // Preview authorizes like a write (writable owner, full scope) and reads live team
  // configuration, but persists nothing: it stays behind the write admission check.
  expect(all.find((unit) => unit.id === 'mcp:preview_workflow')?.gate).toBe('write')
})

function mcpCall(app: App, key: string, name: string, args: Record<string, unknown>) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
}

type App = ReturnType<typeof createApp>
type Result = {
  isError?: boolean
  content: { text: string }[]
  structuredContent?: Record<string, unknown>
}

async function mcpResult(response: Response): Promise<Result> {
  expect(response.status).toBe(200)
  const body = await response.text()
  const data = body.split('\n').find((line) => line.startsWith('data: '))
  return JSON.parse(data ? data.slice(6) : body).result
}

describe.skipIf(!process.env.DATABASE_URL)('MCP team SSO gate', () => {
  let database: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth
  const ran: string[] = []

  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    authPool = createAuthPool(database.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret: randomBytes(32).toString('base64'),
      mailer: { send: async () => expect.unreachable('MCP gate tests send no mail') },
      signup,
    })
  })

  afterAll(async () => {
    await authPool?.end()
    await database?.drop()
  })

  function app(tools: readonly Tool[]) {
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl,
      mcp: mcpEndpoint({ tools }),
      ssoTeamReads: { db, capabilities: { ssoOidcEnabled: false, ssoSamlEnabled: false } },
    })
  }

  async function team(requireSso: boolean) {
    const owner = await createTestUser(db, 'MCP gate owner')
    const { id: teamId } = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    if (requireSso)
      await db
        .insertInto('sso_policies')
        .values({ organization_id: teamId, require_sso: true })
        .execute()
    const eventTypeId = await createFixtures(db).eventType(teamId, null, {
      title: 'Before',
      hosts: [{ userId: owner.id }],
    })
    const { key } = await auth.api.createApiKey({
      body: { userId: owner.id, metadata: { organizationId: teamId, scope: 'full' } },
    })
    return { teamId, eventTypeId, key }
  }

  it('refuses every gated tool and mode with sso_required before its handler runs', async () => {
    const { teamId, key } = await team(true)
    // Feature switches and argument schemas run before the gate and are tested elsewhere;
    // removing them lets every gated tool (including hard-off ones) reach the gate here.
    // A handler that runs records its name, so a refusal provably precedes any side effect.
    const tools = catalog(db).map(
      (tool): Tool => ({
        ...tool,
        requireEnabled: undefined,
        requireAvailable: undefined,
        input: z.looseObject({}),
        run: async () => {
          ran.push(tool.name)
          throw new DomainError('not_found', 'handler_reached', tool.name)
        },
      }),
    )
    const gated = units(tools).filter((unit) => unit.gate !== 'none')
    expect(gated.length).toBeGreaterThanOrEqual(71)
    const gatedApp = app(tools)
    const outcomes: string[] = []
    for (const unit of gated) {
      // Mixed tools select their host mode by bookingId.
      const args = unit.mode === 'host' ? { bookingId: teamId } : {}
      const result = await mcpResult(await mcpCall(gatedApp, key, unit.tool, args))
      outcomes.push(`${unit.id} ${result.isError ? 'error' : 'ok'} ${result.content[0]?.text}`)
    }
    expect(outcomes).toEqual(gated.map((unit) => `${unit.id} error {"error":"sso_required"}`))
    expect(ran).toEqual([])

    // The exceptions still reach their handlers on the same enforced team.
    const profile = await mcpResult(await mcpCall(gatedApp, key, 'get_profile', {}))
    expect(profile.content[0]?.text).toContain('"error":"handler_reached"')
    expect(ran).toEqual(['get_profile'])
    ran.length = 0
  })

  it('leaves tools on a team without a policy working as before', async () => {
    const { eventTypeId, key } = await team(false)
    const plain = app(catalog(db))
    const created = await mcpResult(
      await mcpCall(plain, key, 'create_webhook', {
        url: 'https://hooks.example.com/bookings',
        events: ['booking.created'],
        isActive: false,
      }),
    )
    expect(created.isError).toBeUndefined()
    const webhook = (created.structuredContent as { webhook: { id: string } }).webhook
    const listed = await mcpResult(await mcpCall(plain, key, 'list_webhooks', {}))
    expect(listed.structuredContent).toMatchObject({ data: [{ id: webhook.id }] })
    const updated = await mcpResult(
      await mcpCall(plain, key, 'update_event_type', { id: eventTypeId, title: 'After' }),
    )
    expect(updated.structuredContent).toMatchObject({ id: eventTypeId, title: 'After' })
    const whoami = await mcpResult(await mcpCall(plain, key, 'whoami', {}))
    expect(whoami.isError).toBeUndefined()
  })
})
