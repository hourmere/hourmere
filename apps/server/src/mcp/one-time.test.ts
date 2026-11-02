// Adapter coverage and in-memory mutations. The service's real claim/concurrency tests
// live in scheduling; these assertions cover transport dispatch, scopes and secret handling.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { inspect } from 'node:util'
import { z } from '@hono/zod-openapi'
import * as auth from '@hourmere/auth'
import * as calendars from '@hourmere/calendars'
import type { Db } from '@hourmere/db'
import * as scheduling from '@hourmere/scheduling'
import { describe, expect, it, vi } from 'vitest'
import { hasUnsafeJsonText } from '../app.ts'
import { redactOneTimeLogDetails } from '../one-time-link-privacy.ts'
import * as limits from '../rate-limit.ts'
import * as bookingSchemas from '../routes/bookings.ts'
import * as publicSchemas from '../routes/public.ts'
import type { bookingTools } from './bookings.ts'
import { defineTool, type McpCaller, runTool, type Tool } from './tools.ts'

type Change = readonly [string, string]
const TOKEN = 'synthetic_one_time_capability_sentinel_1234'
const invitee = { name: 'Edited invitee', email: 'edited@example.test', timeZone: 'UTC' }
const caller: Extract<McpCaller, { kind: 'api_key' }> = {
  kind: 'api_key',
  apiKeyId: randomUUID(),
  apiKeyScope: 'bookings',
  user: { id: randomUUID(), name: 'Agent', email: 'agent@example.test' },
  organization: { id: randomUUID(), name: 'Personal', slug: 'agent', personal: true },
}
const input = {
  oneTimeToken: TOKEN,
  start: '2026-11-02T09:00:00Z',
  durationMinutes: 45,
  invitee,
  guests: [{ name: 'Guest', email: 'guest@example.test' }],
  responses: { topic: 'Edited answer' },
  idempotencyKey: randomUUID(),
}
const booked = {
  booking: {
    id: randomUUID(),
    eventTypeId: randomUUID(),
    status: 'confirmed' as const,
    start: input.start,
    end: '2026-11-02T09:45:00Z',
    title: 'One-time meeting',
    location: null,
    responses: input.responses,
    attendees: [{ ...invitee, isBooker: true, locale: null }],
    rescheduledFromId: null,
    cancelledAt: null,
    cancelReason: null,
    source: 'mcp' as const,
    createdAt: '2026-11-01T00:00:00Z',
  },
  manageToken: null,
  replayed: false,
}

function compile<T>(
  file: string,
  name: string,
  bindings: Record<string, unknown>,
  change?: Change,
) {
  let source = readFileSync(file, 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  return new Function(...Object.keys(bindings), `${source}; return ${name}`)(
    ...Object.values(bindings),
  ) as T
}
function factory(change?: Change, service = vi.fn(async () => booked)) {
  const build = compile<typeof bookingTools>(
    'apps/server/src/mcp/bookings.ts',
    'bookingTools',
    {
      z,
      ...calendars,
      ...scheduling,
      ...limits,
      ...bookingSchemas,
      ...publicSchemas,
      defineTool,
      createOneTimeBooking: service,
    },
    change,
  )
  const tool = build({ db: {} as Db }).find((candidate) => candidate.name === 'create_booking')
  if (!tool) throw new Error('Missing booking tool')
  return { tool, service }
}
function runner(change?: Change) {
  return compile<typeof runTool>(
    'apps/server/src/mcp/tools.ts',
    'runTool',
    {
      z,
      ...auth,
      DomainError: scheduling.DomainError,
      WaitlistRateLimitError: scheduling.WaitlistRateLimitError,
      hasUnsafeJsonText,
      inspect,
      redactOneTimeLogDetails,
    },
    change,
  )
}
const errorCode = (result: Awaited<ReturnType<typeof runTool>>) => {
  const first = result.content[0]
  if (first?.type !== 'text') throw new Error('Missing error result')
  return JSON.parse(first.text).error as string
}

async function verifyForwarding(change?: Change) {
  const { tool, service } = factory(change)
  const rateLimit = vi.fn()
  const result = await runTool(tool, input, { caller, rateLimit }, vi.fn())
  expect(result.isError).toBeFalsy()
  expect(rateLimit).toHaveBeenCalledTimes(1)
  const call = service.mock.calls[0] as unknown as [unknown, Record<string, unknown>, unknown]
  expect(call[1].token === TOKEN).toBe(true)
  const { token: _token, start, ...forwarded } = call[1]
  const { oneTimeToken: _secret, start: _start, ...expected } = input
  expect(String(start)).toBe(input.start)
  expect(forwarded).toEqual(expected)
  expect(call[2]).toEqual({
    source: 'mcp',
    apiKeyId: caller.apiKeyId,
    oauthConsentId: null,
    actorUserId: caller.user.id,
  })
  expect(JSON.stringify(result).includes(TOKEN)).toBe(false)
}
async function verifyExclusive(change?: Change) {
  const { tool, service } = factory(change)
  for (const extra of [{ handle: 'host' }, { teamSlug: 'team' }, { slug: 'event' }]) {
    const result = await runTool(
      tool,
      { ...input, ...extra },
      { caller, rateLimit: () => {} },
      vi.fn(),
    )
    expect(errorCode(result)).toBe('invalid_request')
  }
  expect(service).not.toHaveBeenCalled()
}
async function verifyValidationPrivacy(run = runTool) {
  const { tool, service } = factory()
  for (const args of [
    { ...input, [TOKEN]: 'unknown' },
    { ...input, responses: { [TOKEN]: { invalid: true } } },
    { ...input, oneTimeToken: `invalid ${TOKEN}` },
  ]) {
    const logs = vi.fn()
    const result = await run(tool, args, { caller, rateLimit: () => {} }, logs)
    expect(errorCode(result)).toBe('invalid_request')
    expect(JSON.stringify(result).includes(TOKEN)).toBe(false)
    expect(JSON.stringify(logs.mock.calls).includes(TOKEN)).toBe(false)
  }
  expect(service).not.toHaveBeenCalled()
}
async function verifyErrorPrivacy(run = runTool) {
  const { tool } = factory()
  for (const [thrown, message] of [
    [new Error(`Driver unavailable ${TOKEN}\nretry later`), 'Error: Driver unavailable'],
    [
      new scheduling.DomainError('invalid', 'invalid_answers', `Question ${TOKEN}`, {
        cause: new Error(`Wrapped driver unavailable ${TOKEN}\nretry later`),
      }),
      'Error: Wrapped driver unavailable',
    ],
  ] as const) {
    const logs = vi.fn()
    const failing: Tool = {
      ...tool,
      run: async () => {
        throw thrown
      },
    }
    const result = await run(failing, input, { caller, rateLimit: () => {} }, logs)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result).includes(TOKEN)).toBe(false)
    expect(logs).toHaveBeenCalledTimes(1)
    const line = logs.mock.calls.map((args) => args.map(String).join(' ')).join(' ')
    expect(line).toContain(message)
    expect(line).toContain('at ')
    expect(line).toContain('\\n')
    expect(line.includes('\n')).toBe(false)
    expect(line.includes(TOKEN)).toBe(false)
  }
}
async function verifyResultPrivacy(run = runTool) {
  const { tool } = factory()
  const logs = vi.fn()
  const failing: Tool = {
    ...tool,
    run: async () => ({
      ...booked,
      booking: { ...booked.booking, responses: { [TOKEN]: { invalid: true } } },
    }),
  }
  const result = await run(failing, input, { caller, rateLimit: () => {} }, logs)
  expect(errorCode(result)).toBe('internal_error')
  expect(logs).toHaveBeenCalledTimes(1)
  expect(logs.mock.calls.map((args) => args.map(String).join(' ')).join(' ')).toContain('ZodError')
  expect(
    logs.mock.calls
      .map((args) => args.map(String).join(' '))
      .join(' ')
      .includes(TOKEN),
  ).toBe(false)
}

describe('one-time booking MCP adapter', () => {
  it('forwards the capability and editable booking data with MCP attribution', () =>
    verifyForwarding())
  it('rejects mixed public and capability namespaces', () => verifyExclusive())
  it('does not echo capabilities through malformed input diagnostics', () =>
    verifyValidationPrivacy())
  it('does not echo capabilities through service errors or logs', () => verifyErrorPrivacy())
  it('does not echo capabilities through rejected result diagnostics', () => verifyResultPrivacy())
  it('returns idempotent service replay without claiming separately', async () => {
    const service = vi.fn(async () => ({ ...booked, replayed: true }))
    const { tool } = factory(undefined, service)
    const result = await runTool(tool, input, { caller, rateLimit: () => {} }, vi.fn())
    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as { replayed: boolean }).replayed).toBe(true)
    expect(service).toHaveBeenCalledTimes(1)
  })
  it('denies read keys before capability consumption', async () => {
    const { tool, service } = factory()
    const result = await runTool(
      tool,
      input,
      { caller: { ...caller, apiKeyScope: 'read' }, rateLimit: () => {} },
      vi.fn(),
    )
    expect(errorCode(result)).toBe('insufficient_scope')
    expect(service).not.toHaveBeenCalled()
  })
  it('exercises unchanged source copies before mutation controls', async () => {
    await verifyForwarding()
    await verifyExclusive()
    await verifyValidationPrivacy(runner())
    await verifyErrorPrivacy(runner())
    await verifyResultPrivacy(runner())
  })
  it('kills weakened token input validation with a real assertion failure', async () => {
    const { tool } = factory(['.regex(/^[A-Za-z0-9_-]{43}$/)', '.min(1)'])
    await expect(
      (async () => {
        const result = await runTool(
          tool,
          { ...input, oneTimeToken: 'bad' },
          { caller, rateLimit: () => {} },
          vi.fn(),
        )
        expect(errorCode(result)).toBe('invalid_request')
      })(),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('kills bypassed capability dispatch with a real assertion failure', async () => {
    await expect(
      verifyForwarding(['if (args.oneTimeToken !== undefined) {', 'if (false) {']),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('kills mixed namespace acceptance with a real assertion failure', async () => {
    await expect(
      verifyExclusive([
        'v.handle === undefined && v.teamSlug === undefined && v.slug === undefined',
        'true',
      ]),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it.each([
    [
      'validation privacy',
      "privateInput ? 'Invalid booking request' : describeIssues(parsed.error.issues)",
      'describeIssues(parsed.error.issues)',
      verifyValidationPrivacy,
    ],
    ['error logging privacy', 'diagnostic(err)', 'err', verifyErrorPrivacy],
    ['domain error privacy', 'err.detail && !privateInput', 'err.detail', verifyErrorPrivacy],
    ['domain cause privacy', 'diagnostic(err.cause)', 'err.cause', verifyErrorPrivacy],
    ['error diagnostics', 'diagnostic(err)', "'Private booking call failed'", verifyErrorPrivacy],
    ['domain cause diagnostics', 'if (err.cause !== undefined)', 'if (false)', verifyErrorPrivacy],
    ['result logging privacy', 'diagnostic(result.error)', 'result.error', verifyResultPrivacy],
    [
      'result diagnostics',
      'diagnostic(result.error)',
      "'Private booking result rejected'",
      verifyResultPrivacy,
    ],
  ] as const)(
    'kills removed %s with a real assertion failure',
    async (_name, before, after, verify) => {
      await expect(verify(runner([before, after]))).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )
})
