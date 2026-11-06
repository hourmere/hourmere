import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { inspect } from 'node:util'
import { z } from '@hono/zod-openapi'
import * as auth from '@hourmere/auth'
import * as calendars from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { auditActor } from '@hourmere/db/audit'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import * as scheduling from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp, hasUnsafeJsonText } from '../app.ts'
import { redactOneTimeLogDetails } from '../one-time-link-privacy.ts'
import * as rateLimits from '../rate-limit.ts'
import * as bookingSchemas from '../routes/bookings.ts'
import * as schemas from '../routes/event-types.ts'
import * as publicSchemas from '../routes/public.ts'
import type { bookingTools } from './bookings.ts'
import { mcpEndpoint } from './endpoint.ts'
import { defineTool, type McpCaller, prepareTools, runTool, type Tool } from './tools.ts'
import { waitlistTools } from './waitlist.ts'

type Change = readonly [string, string]
type Factory = typeof waitlistTools
const now = () => Temporal.Instant.from('2026-11-01T12:00:00Z')
const secret = 'synthetic-waitlist-interface-secret'
const publicUrl = 'http://localhost:4194'
const args = {
  handle: 'host',
  slug: 'intro',
  email: 'invitee@example.test',
  consent: true,
  preferredWindow: {
    start: '2026-11-02T00:00:00Z',
    end: '2026-11-03T00:00:00Z',
    timeZone: 'UTC',
  },
}
const principal: McpCaller = {
  kind: 'api_key',
  apiKeyId: randomUUID(),
  apiKeyScope: 'full',
  user: { id: randomUUID(), name: 'Waitlist host', email: 'host@example.test' },
  organization: { id: randomUUID(), name: 'Personal', slug: 'personal', personal: true },
}
function sourceCopy(change?: Change, bindings: Record<string, unknown> = {}): Factory {
  let source = readFileSync('apps/server/src/mcp/waitlist.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation anchor').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const dependencies = {
    z,
    ...scheduling,
    ...schemas,
    ...publicSchemas,
    ...rateLimits,
    defineTool,
    ...bindings,
  }
  return new Function(...Object.keys(dependencies), `${source}; return waitlistTools`)(
    ...Object.values(dependencies),
  ) as Factory
}
function frameworkCopy(change?: Change) {
  let source = readFileSync('apps/server/src/mcp/tools.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'framework mutation anchor').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = {
    auditActor,
    z,
    inspect,
    ...auth,
    ...scheduling,
    hasUnsafeJsonText,
    redactOneTimeLogDetails,
  }
  return new Function(...Object.keys(bindings), `${source}; return {runTool,registerTools}`)(
    ...Object.values(bindings),
  ) as Pick<typeof import('./tools.ts'), 'runTool' | 'registerTools'>
}
function find(tools: Tool[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw Error('Expected waitlist tool')
  return tool
}
function error(result: Awaited<ReturnType<typeof runTool>>) {
  expect(result.isError).toBe(true)
  const content = result.content[0]
  if (content?.type !== 'text') throw Error('Expected error text')
  return JSON.parse(content.text)
}
const call = (tool: Tool, input: unknown, caller: McpCaller = principal) =>
  runTool(tool, input, { caller, trustedIp: '192.0.2.45', rateLimit: () => {} }, () => {})

describe('MCP waitlist adapter protections', () => {
  const admissionTools = ['join_waitlist', 'resend_waitlist_verification'] as const
  function toolMutation(name: string, before: string, after: string): Change {
    const source = readFileSync('apps/server/src/mcp/waitlist.ts', 'utf8')
    const start = source.indexOf(`name: '${name}',`)
    const end = source.indexOf('\n    }),', start)
    const block = source.slice(start, end)
    expect(block.includes(before), 'tool mutation anchor').toBe(true)
    return [block, block.replace(before, after)]
  }
  async function verifyAdmissionBudget(
    name?: (typeof admissionTools)[number],
    change?: Change,
    rejected = false,
  ) {
    const service = vi.fn(async () => {
      if (rejected) throw new scheduling.DomainError('not_found', 'event_type_not_found')
      return { accepted: true }
    })
    const registry = sourceCopy(change, {
      joinWaitlist: service,
      resendWaitlistVerification: service,
    })({ db: {} as Db, secret })
    const other: McpCaller = { ...principal, user: { ...principal.user, id: randomUUID() } }
    const app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async (headers) => ({
        ok: true,
        principal:
          headers.get('authorization') === 'Bearer hm_other_user'
            ? other
            : { ...principal, apiKeyId: randomUUID() },
        setCookie: [],
      }),
      mcp: mcpEndpoint({ tools: registry }),
    })
    async function request(tool: (typeof admissionTools)[number], key = 'hm_first_key') {
      const input =
        tool === 'join_waitlist'
          ? args
          : { handle: args.handle, slug: args.slug, email: args.email }
      const response = await app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool, arguments: input },
        }),
      })
      expect(response.status).toBe(200)
      const body = await response.text()
      const data = body.split('\n').find((line) => line.startsWith('data: '))
      return JSON.parse(data ? data.slice(6) : body).result as Awaited<ReturnType<typeof runTool>>
    }
    for (let i = 0; i < 10; i++) {
      const result = await request(
        name ?? (admissionTools[i % 2] as (typeof admissionTools)[number]),
      )
      if (rejected) expect(error(result).error).toBe('event_type_not_found')
      else expect(result.structuredContent).toEqual({ accepted: true })
    }
    expect(service).toHaveBeenCalledTimes(10)
    const denied = error(await request(name ?? 'join_waitlist', 'hm_another_key_for_same_user'))
    expect(denied.error).toBe('rate_limited')
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60)
    expect(service).toHaveBeenCalledTimes(10)
    const separate = await request(name ?? 'resend_waitlist_verification', 'hm_other_user')
    if (rejected) expect(error(separate).error).toBe('event_type_not_found')
    else expect(separate.structuredContent).toEqual({ accepted: true })
    expect(service).toHaveBeenCalledTimes(11)
  }
  it.each(admissionTools)(
    'counts every generic %s acceptance against the per-user call budget',
    (name) => verifyAdmissionBudget(name),
  )
  it.each(admissionTools)('counts service-rejected %s requests before resource lookup', (name) =>
    verifyAdmissionBudget(name, undefined, true),
  )
  it('shares the call budget across join and resend and all keys, while separating users', () =>
    verifyAdmissionBudget())
  it.each(admissionTools)('kills removing the per-user call limit from %s', async (name) => {
    await expect(
      verifyAdmissionBudget(
        name,
        toolMutation(name, '        call.rateLimit(admissionLimit)\n', ''),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  function verifyRetryAnnotation(name: (typeof admissionTools)[number], change?: Change) {
    expect(
      find(sourceCopy(change)({ db: {} as Db, secret }), name).annotations.idempotentHint,
    ).toBe(false)
  }
  it.each(admissionTools)('advertises no idempotent retry guarantee for %s', (name) =>
    verifyRetryAnnotation(name),
  )
  it.each(admissionTools)('kills an idempotent retry guarantee for %s', (name) => {
    expect(() =>
      verifyRetryAnnotation(
        name,
        toolMutation(name, 'idempotentHint: false', 'idempotentHint: true'),
      ),
    ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
  async function verifyPrivateDiagnostics(
    name: (typeof admissionTools)[number],
    frameworkChange?: Change,
    toolChange?: Change,
  ) {
    const privateValues = [
      'synthetic-private@example.test',
      'Private Name Example',
      '2026-11-12T04:00:00Z',
      '192.0.2.177',
    ]
    const detail = `database diagnostic contact ${privateValues.join(' ')}`
    for (const thrown of [
      new Error(detail),
      new scheduling.DomainError('invalid', 'invalid_waitlist_input', undefined, {
        cause: new Error(detail),
      }),
      { detail, email: privateValues[0] },
    ]) {
      const fail = async () => {
        throw thrown
      }
      const registry = sourceCopy(toolChange, {
        joinWaitlist: fail,
        resendWaitlistVerification: fail,
      })({ db: {} as Db, secret })
      const logs = vi.fn()
      const input =
        name === 'join_waitlist'
          ? args
          : { handle: args.handle, slug: args.slug, email: args.email }
      const result = await frameworkCopy(frameworkChange).runTool(
        find(registry, name),
        input,
        { caller: principal, rateLimit: () => {} },
        logs,
      )
      expect(result.isError).toBe(true)
      expect(logs).toHaveBeenCalledTimes(1)
      const logged = logs.mock.calls.map((values) => values.map(String).join(' ')).join(' ')
      for (const value of privateValues) expect(logged.includes(value)).toBe(false)
      expect(logged).toContain('[private request diagnostic omitted]')
      if (thrown instanceof scheduling.DomainError)
        expect(logged).toContain('invalid_waitlist_input')
    }
  }
  it.each(admissionTools)(
    'omits email, name, window and IP from %s exception diagnostics',
    (name) => verifyPrivateDiagnostics(name),
  )
  it.each(admissionTools)('kills allowing freeform private diagnostics in %s', async (name) => {
    await expect(
      verifyPrivateDiagnostics(
        name,
        undefined,
        toolMutation(name, 'privateDiagnostics: true', 'privateDiagnostics: false'),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('kills removing private diagnostic suppression from the framework', async () => {
    await expect(
      verifyPrivateDiagnostics('join_waitlist', ['tool.privateDiagnostics\n', 'false\n']),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  async function verifyForwarding(factory: Factory, team = false) {
    const tools = factory({ db: {} as Db, secret, publicUrl, now })
    const input = team ? { ...args, handle: undefined, teamSlug: 'team' } : args
    for (const name of ['join_waitlist', 'resend_waitlist_verification']) {
      const tool = find(tools, name)
      const actual = await tool.run(
        name === 'join_waitlist' ? input : { ...input, email: args.email },
        { caller: principal, trustedIp: '192.0.2.45', rateLimit: () => {} },
      )
      expect(actual).toEqual({ accepted: true })
    }
  }
  async function verifyTrustedIp(change?: Change) {
    const join = vi.fn(async (..._input: unknown[]) => ({ accepted: true as const }))
    const factory = sourceCopy(change, { joinWaitlist: join })
    const result = await call(
      find(factory({ db: {} as Db, secret, publicUrl, now }), 'join_waitlist'),
      args,
    )
    expect(result.isError).toBeFalsy()
    expect(join.mock.calls[0]?.[0]).toMatchObject({ trustedIp: '192.0.2.45', secret, publicUrl })
  }
  it('forwards only the trusted transport IP to durable admission', () => verifyTrustedIp())
  it('kills dropping the trusted IP with a real assertion', async () => {
    await expect(
      verifyTrustedIp(['trustedIp: call.trustedIp', 'trustedIp: undefined']),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it.each([false, true])(
    'forwards personal/team=%s references to shared admission services',
    async (team) => {
      const join = vi.fn(async (..._input: unknown[]) => ({ accepted: true as const }))
      const resend = vi.fn(async (..._input: unknown[]) => ({ accepted: true as const }))
      const factory = sourceCopy(undefined, {
        joinWaitlist: join,
        resendWaitlistVerification: resend,
      })
      await verifyForwarding(factory, team)
      for (const service of [join, resend])
        expect(service.mock.calls[0]?.[1]).toMatchObject({
          handle: team ? 'team' : 'host',
          team,
          slug: 'intro',
          email: args.email,
        })
    },
  )
  async function verifyStrictInput(change?: Change) {
    const join = vi.fn(async () => ({ accepted: true as const }))
    const tool = find(
      sourceCopy(change, { joinWaitlist: join })({ db: {} as Db, secret }),
      'join_waitlist',
    )
    expect(error(await call(tool, { ...args, trustedIp: '198.51.100.1' })).error).toBe(
      'invalid_request',
    )
    expect(join).not.toHaveBeenCalled()
  }
  it('rejects forged source IP and authority fields before service dispatch', () =>
    verifyStrictInput())
  it('kills permissive input schemas with a real assertion', async () => {
    await expect(
      verifyStrictInput([
        'WaitlistJoinBody.extend(PageReference)',
        'WaitlistJoinBody.extend(PageReference).passthrough()',
      ]),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('requires a unique page reference and explicit consent', async () => {
    const tools = waitlistTools({ db: {} as Db, secret })
    for (const input of [
      { ...args, teamSlug: 'team' },
      { ...args, handle: undefined },
      { ...args, consent: false },
      { ...args, consent: undefined },
      { ...args, organizationId: randomUUID() },
    ])
      expect(error(await call(find(tools, 'join_waitlist'), input)).error).toBe('invalid_request')
  })
  async function verifyPrivateErrors(change?: Change) {
    const tool = find(sourceCopy(change)({ db: {} as Db, secret }), 'join_waitlist')
    const result = error(await call(tool, { ...args, [args.email]: true }))
    expect(JSON.stringify(result).includes(args.email)).toBe(false)
  }
  it('never repeats email-bearing validation input', () => verifyPrivateErrors())
  async function verifyAcceptedPrivacy(change?: Change) {
    const token = 'synthetic_waitlist_response_capability'
    const joinWaitlist = async () => ({
      accepted: true,
      verificationToken: token,
      removalToken: token,
      email: args.email,
    })
    const tools = sourceCopy(change, { joinWaitlist })({ db: {} as Db, secret })
    const result = await call(find(tools, 'join_waitlist'), args)
    expect(result.structuredContent).toEqual({ accepted: true })
    expect(JSON.stringify(result).includes(token)).toBe(false)
    expect(JSON.stringify(result).includes(args.email)).toBe(false)
  }
  it('returns only generic acceptance even if a service adds private fields', () =>
    verifyAcceptedPrivacy())
  it('kills allowing private fields into the join response', async () => {
    await expect(
      verifyAcceptedPrivacy([
        'output: z.object({ accepted: z.literal(true) })',
        'output: z.object({ accepted: z.literal(true) }).passthrough()',
      ]),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('kills removing private diagnostics with a real assertion', async () => {
    await expect(
      verifyPrivateErrors(['privateInput: () => true', 'privateInput: () => false']),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it.each(['join_waitlist', 'resend_waitlist_verification'])(
    'surfaces durable limits neutrally in %s',
    async (name) => {
      const reject = async () => {
        throw new scheduling.WaitlistRateLimitError(45)
      }
      const tools = sourceCopy(undefined, {
        joinWaitlist: reject,
        resendWaitlistVerification: reject,
      })({ db: {} as Db, secret })
      const result = await call(
        find(tools, name),
        name === 'join_waitlist' ? args : { handle: 'host', slug: 'intro', email: args.email },
      )
      expect(error(result)).toEqual({ error: 'rate_limited', retryAfterSeconds: 45 })
    },
  )
  async function verifyRateResponse(change?: Change) {
    const tools = sourceCopy(undefined, {
      joinWaitlist: async () => {
        throw new scheduling.WaitlistRateLimitError(45)
      },
    })({ db: {} as Db, secret })
    const result = await frameworkCopy(change).runTool(
      find(tools, 'join_waitlist'),
      args,
      { caller: principal, rateLimit: () => {} },
      () => {},
    )
    expect(error(result)).toEqual({ error: 'rate_limited', retryAfterSeconds: 45 })
  }
  it('kills dropping durable rate-limit response handling', async () => {
    await verifyRateResponse()
    await expect(
      verifyRateResponse(['if (err instanceof WaitlistRateLimitError)', 'if (false)']),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  async function verifyRegisteredIp(change?: Change) {
    let registered: ((args: unknown) => Promise<unknown>) | undefined
    const seen: (string | undefined)[] = []
    const tool: Tool = {
      ...find(waitlistTools({ db: {} as Db }), 'join_waitlist'),
      run: async (_args, transport) => {
        seen.push(transport.trustedIp)
        return { accepted: true }
      },
    }
    const register = frameworkCopy(change).registerTools
    const fake = {
      registerTool: (
        _name: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) => {
        registered = handler
      },
      server: { setRequestHandler: () => {} },
    } as unknown as Parameters<typeof register>[0]
    register(fake, prepareTools([tool]), principal, () => {}, '192.0.2.46')
    if (!registered) throw Error('Expected registered tool')
    await registered(args)
    expect(seen).toEqual(['192.0.2.46'])
  }
  it('kills dropping the trusted address while registering tools', async () => {
    await verifyRegisteredIp()
    await expect(
      verifyRegisteredIp([
        '    trustedIp,\n    rateLimit',
        '    trustedIp: undefined,\n    rateLimit',
      ]),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('takes the IP from the HTTP socket rather than caller headers', async () => {
    const seen: (string | undefined)[] = []
    const tool: Tool = {
      ...find(waitlistTools({ db: {} as Db }), 'join_waitlist'),
      run: async (_args, transport) => {
        seen.push(transport.trustedIp)
        return { accepted: true }
      },
    }
    const app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
      mcp: mcpEndpoint({ tools: [tool] }),
    })
    const response = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer hm_synthetic_waitlist',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-forwarded-for': '198.51.100.55',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'join_waitlist', arguments: args },
        }),
      },
      { incoming: { socket: { remoteAddress: '192.0.2.90' } } },
    )
    expect(response.status).toBe(200)
    expect(seen).toEqual(['192.0.2.90'])
  })

  async function verifyBookingAttribution(change?: Change, team = false) {
    let source = readFileSync('apps/server/src/mcp/bookings.ts', 'utf8')
    if (change) {
      expect(source.includes(change[0]), 'booking mutation anchor').toBe(true)
      source = source.replace(...change)
    }
    source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
      /\bexport /g,
      '',
    )
    const create = vi.fn(async (..._input: unknown[]) => ({ replayed: false }))
    const dependencies = {
      auditActor,
      z,
      ...calendars,
      ...scheduling,
      ...rateLimits,
      ...bookingSchemas,
      ...publicSchemas,
      defineTool,
      createPublicBooking: create,
      createPublicTeamBooking: create,
    }
    const factory = new Function(...Object.keys(dependencies), `${source}; return bookingTools`)(
      ...Object.values(dependencies),
    ) as typeof bookingTools
    const attribution = 'synthetic-waitlist-attribution'
    await find(factory({ db: {} as Db, waitlistSecret: secret, now }), 'create_booking').run(
      {
        ...(team ? { teamSlug: 'team' } : { handle: 'host' }),
        slug: 'intro',
        start: '2026-11-02T09:00:00Z',
        invitee: { name: 'Invitee', email: args.email, timeZone: 'UTC' },
        waitlistToken: attribution,
      },
      { caller: principal, rateLimit: () => {} },
    )
    expect(create.mock.calls[0]?.[0]).toMatchObject({ waitlistSecret: secret })
    expect(
      (create.mock.calls[0]?.[1] as Record<string, unknown> | undefined)?.waitlistToken ===
        attribution,
    ).toBe(true)
  }
  it.each([false, true])('forwards ordinary booking attribution for team=%s', (team) =>
    verifyBookingAttribution(undefined, team),
  )
  it.each([
    ['          waitlistToken: args.waitlistToken,\n', ''],
    ['    db,\n    waitlistSecret,\n    now,', '    db,\n    now,'],
  ] as const)('kills dropping waitlist booking attribution: %s', async (before, after) => {
    await expect(verifyBookingAttribution([before, after])).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
})

describe.skipIf(!process.env.DATABASE_URL)('MCP and CLI waitlist with shared services', () => {
  let owned: TestDatabase
  let db: Db
  let owner: Extract<McpCaller, { kind: 'api_key' }>
  let member: Extract<McpCaller, { kind: 'api_key' }>
  let eventId: string
  let handle: string
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    const fixtures = createFixtures(db)
    const host = await fixtures.host({ timeZone: 'UTC' })
    const teammate = await fixtures.host({ timeZone: 'UTC' })
    const teamId = await fixtures.organization()
    await fixtures.member(host.userId, teamId, 'owner')
    await fixtures.member(teammate.userId, teamId, 'member')
    const organization = await db
      .selectFrom('auth.organization')
      .select(['name', 'slug'])
      .where('id', '=', teamId)
      .executeTakeFirstOrThrow()
    owner = {
      ...principal,
      user: { ...principal.user, id: host.userId },
      organization: { id: teamId, ...organization, personal: false },
    }
    member = { ...owner, user: { ...owner.user, id: teammate.userId } }
    eventId = await fixtures.eventType(teamId, null, {
      slug: 'intro',
      hosts: [{ userId: host.userId }],
    })
    handle = organization.slug
  })
  afterAll(async () => {
    await owned?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('waitlist_verification_requests').execute()
  })
  const tools = () => waitlistTools({ db, secret, publicUrl, now })
  it('round-trips settings and returns identical acceptance for new and existing email', async () => {
    const registry = tools()
    expect(
      (await call(find(registry, 'get_event_type_waitlist'), { id: eventId }, owner))
        .structuredContent,
    ).toEqual({ enabled: false })
    expect(
      (await call(find(registry, 'set_event_type_waitlist'), { id: eventId, enabled: true }, owner))
        .structuredContent,
    ).toEqual({ enabled: true })
    const input = { ...args, handle: undefined, teamSlug: handle }
    const joined = await call(find(registry, 'join_waitlist'), input, owner)
    expect(joined.isError).toBeFalsy()
    expect(joined.structuredContent).toEqual({ accepted: true })
    expect(await call(find(registry, 'join_waitlist'), input, owner)).toEqual(joined)
    expect(
      await db
        .selectFrom('waitlist_entries')
        .select('id')
        .where('event_type_id', '=', eventId)
        .execute(),
    ).toHaveLength(1)
  })
  it('exposes contacts to managers, denies members, and removes idempotently without tokens', async () => {
    const registry = tools()
    for (const [name, input] of [
      ['get_event_type_waitlist', { id: eventId }],
      ['list_waitlist_entries', { id: eventId }],
      ['set_event_type_waitlist', { id: eventId, enabled: false }],
    ] as const)
      expect(error(await call(find(registry, name), input, member)).error).toBe('insufficient_role')
    const listed = await call(
      find(registry, 'list_waitlist_entries'),
      { id: eventId },
      { ...owner, apiKeyScope: 'read' },
    )
    expect(listed.isError).toBeFalsy()
    const page = listed.structuredContent as { data: { id: string; email: string }[] }
    expect(page.data[0]?.email === args.email).toBe(true)
    expect(JSON.stringify(page).includes('Token')).toBe(false)
    const entryId = page.data[0]?.id
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        (await call(find(registry, 'remove_waitlist_entry'), { id: eventId, entryId }, owner))
          .structuredContent,
      ).toEqual({ removed: true })
    expect(
      error(await call(find(registry, 'remove_waitlist_entry'), { id: eventId, entryId }, member))
        .error,
    ).toBe('insufficient_role')
    const after = await call(find(registry, 'list_waitlist_entries'), { id: eventId }, owner)
    expect(after.structuredContent).toMatchObject({
      data: [{ state: 'removed', email: null, name: null, preferredWindow: null }],
    })
  })
  it.each(['join', 'resend'] as const)(
    'hides listed and unlisted targets in the six-request %s IP-limit probe through MCP',
    async (kind) => {
      const sequences: string[][] = []
      for (const listed of [true, false]) {
        const fixtures = createFixtures(db)
        const host = await fixtures.host({ timeZone: 'UTC' })
        const event = await fixtures.eventType(host.organizationId, host.userId, { slug: 'probe' })
        await db
          .updateTable('event_types')
          .set({ waitlist_enabled: true })
          .where('id', '=', event)
          .execute()
        const input = {
          ...args,
          handle: host.handle,
          slug: 'probe',
          email: `target-${randomUUID()}@example.test`,
        }
        if (listed)
          await scheduling.joinWaitlist(
            { db, secret, publicUrl, now, trustedIp: '192.0.2.83' },
            { ...input, consent: true },
          )
        const app = createApp({
          publicUrl,
          checkDb: async () => {},
          authHandler: async () => new Response(null, { status: 404 }),
          resolveCaller: async () => ({ ok: true, principal: owner, setCookie: [] }),
          mcp: mcpEndpoint({ tools: tools() }),
        })
        const outcomes: string[] = []
        for (let index = 0; index < 6; index++) {
          const resend = index === 0 && kind === 'resend'
          const email = index === 0 ? input.email : `probe-${randomUUID()}@example.test`
          const response = await app.request(
            '/mcp',
            {
              method: 'POST',
              headers: {
                authorization: 'Bearer hm_synthetic_waitlist_probe',
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
              },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: index,
                method: 'tools/call',
                params: {
                  name: resend ? 'resend_waitlist_verification' : 'join_waitlist',
                  arguments: resend
                    ? { handle: input.handle, slug: input.slug, email }
                    : { ...input, email },
                },
              }),
            },
            { incoming: { socket: { remoteAddress: listed ? '198.51.100.83' : '198.51.100.84' } } },
          )
          expect(response.status).toBe(200)
          const body = await response.text()
          const data = body.split('\n').find((line) => line.startsWith('data: '))
          const result = JSON.parse(data ? data.slice(6) : body).result as Awaited<
            ReturnType<typeof runTool>
          >
          if (result.isError) {
            const refusal = error(result)
            expect(refusal).toEqual({ error: 'rate_limited', retryAfterSeconds: 3600 })
            outcomes.push(refusal.error)
          } else {
            expect(result.structuredContent).toEqual({ accepted: true })
            outcomes.push('accepted')
          }
        }
        sequences.push(outcomes)
      }
      expect(sequences[0]).toEqual(sequences[1])
      expect(sequences[0]).toEqual([
        'accepted',
        'accepted',
        'accepted',
        'accepted',
        'accepted',
        'rate_limited',
      ])
    },
  )
  it('runs CLI waitlist commands through real MCP and preserves machine-readable output', async () => {
    const app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: true, principal: owner, setCookie: [] }),
      mcp: mcpEndpoint({ tools: tools() }),
    })
    for (const [command, input, expected] of [
      ['event-waitlist', { id: eventId }, { enabled: true }],
      ['set-event-waitlist', { id: eventId, enabled: false }, { enabled: false }],
      ['waitlist-entries', { id: eventId }, { nextAfter: null }],
    ] as const) {
      let stdout = ''
      let stderr = ''
      const code = await runCli({
        argv: [command, '--input', '-'],
        env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: 'hm_synthetic_waitlist_cli' },
        stdin: (async function* () {
          yield JSON.stringify(input)
        })(),
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        fetch: async (url, init) => app.request(url, init),
      })
      expect(code).toBe(0)
      expect(stderr).toBe('')
      expect(JSON.parse(stdout)).toMatchObject(expected)
    }
  })
})
