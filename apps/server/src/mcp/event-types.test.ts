// Configuration writes use real services and one bounded, owned database pool.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { z } from '@hono/zod-openapi'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import * as scheduling from '@hourmere/scheduling'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import * as schemas from '../routes/event-types.ts'
import { productTools } from '../server.ts'
import { mcpEndpoint } from './endpoint.ts'
import { eventTypeTools } from './event-types.ts'
import { defineTool, type McpCaller, runTool, type Tool } from './tools.ts'

type Factory = typeof eventTypeTools
type Change = readonly [string, string]
type Saved = { id: string; durationMinutes: number; allowedDurationsMinutes: number[] }
type Result = Awaited<ReturnType<typeof runTool>>

function sourceCopy(change?: Change): Factory {
  let source = readFileSync('apps/server/src/mcp/event-types.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match the implementation').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = { z, ...scheduling, ...schemas, defineTool }
  return new Function(...Object.keys(bindings), `${source}; return eventTypeTools`)(
    ...Object.values(bindings),
  ) as Factory
}

function productSourceCopy(change?: Change): Factory {
  const server = readFileSync('apps/server/src/server.ts', 'utf8')
  let source = server.slice(
    server.indexOf('export function productTools('),
    server.indexOf('export interface RunningServer'),
  )
  if (change) {
    expect(source.includes(change[0]), 'product registry mutation must match').toBe(true)
    source = source.replace(...change)
  }
  const bindings = {
    eventTypeTools,
    whoamiTool: { name: 'whoami' },
    bookingTools: () => [],
    catalogTools: () => [],
    integrationTools: () => [],
  }
  return new Function(
    ...Object.keys(bindings),
    `${stripTypeScriptTypes(source).replace(/\bexport /g, '')}; return productTools`,
  )(...Object.values(bindings)) as Factory
}

function ok(result: Result): Saved {
  expect(result.isError).toBeFalsy()
  return result.structuredContent as Saved
}
function error(result: Result) {
  expect(result.isError).toBe(true)
  const content = result.content[0]
  if (content?.type !== 'text') throw Error('Expected error text')
  return JSON.parse(content.text) as { error: string; message?: string }
}

describe.skipIf(!process.env.DATABASE_URL)('MCP and CLI event type configuration', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup(
    factory = eventTypeTools,
    teamRole?: string,
    followUpHostNotesEnabled?: boolean,
  ) {
    const host = await createTestUser(db)
    const team = teamRole ? await createTestTeam(db, [{ user: host, role: teamRole }]) : null
    const caller = (team ? team.as(host) : host.principal) as McpCaller
    const tools = factory({ db, followUpHostNotesEnabled })
    const call = async (name: string, args: Record<string, unknown>) =>
      runTool(
        tools.find((tool) => tool.name === name) as Tool,
        args,
        { caller, rateLimit: () => {} },
        () => {
          throw Error('Unexpected MCP configuration failure')
        },
      )
    const app = createApp({
      publicUrl: 'http://localhost:4189',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: true, principal: caller, setCookie: [] }),
      routes: [schemas.eventTypeRoutes({ db, followUpHostNotesEnabled })],
      mcp: mcpEndpoint({ tools }),
    })
    return { app, call, caller }
  }
  const createInput = () => ({
    slug: `lengths-${randomUUID()}`,
    title: 'Choose a meeting length',
    durationMinutes: 30,
    allowedDurationsMinutes: [60, 30, 15],
  })
  const notifications = {
    reminders: [],
    followUps: [
      {
        id: 'thanks',
        offsetMinutes: 60,
        recipients: { invitee: true, guests: false, host: false },
        hostNote: 'Thank you for meeting',
      },
    ],
  }

  async function verifyHostNotePolicy(factory: Factory, enabled: boolean, update: boolean) {
    const s = await setup(factory, undefined, enabled)
    const created = update
      ? await scheduling.createEventType(
          { db, principal: s.caller, now: () => Temporal.Now.instant() },
          createInput(),
        )
      : null
    const result = await s.call(update ? 'update_event_type' : 'create_event_type', {
      ...(created ? { id: created.id } : createInput()),
      notifications,
    })
    if (enabled) expect(ok(result)).toHaveProperty('notifications', notifications)
    else {
      expect(error(result)).toEqual({
        error: 'invalid_notifications',
        message: 'notifications.followUps[0].hostNote: host notes are disabled by the operator',
      })
    }
  }

  it.each([false, true])(
    'honors the operator host-note switch on both writes for update=%s',
    async (update) => {
      await verifyHostNotePolicy(productTools, false, update)
      await verifyHostNotePolicy(productTools, true, update)
    },
  )

  it('keeps saved notification settings while changing meeting lengths', async () => {
    const s = await setup(productTools, undefined, true)
    const created = ok(await s.call('create_event_type', { ...createInput(), notifications }))
    const updated = ok(
      await s.call('update_event_type', {
        id: created.id,
        durationMinutes: 60,
        allowedDurationsMinutes: [90, 60, 30],
      }),
    )
    expect(updated).toHaveProperty('notifications', notifications)
    expect(updated).toMatchObject({ durationMinutes: 60, allowedDurationsMinutes: [30, 60, 90] })
  })

  it.each([false, true])(
    'detects removal of the tool host-note switch for update=%s',
    async (update) => {
      await verifyHostNotePolicy(sourceCopy(), false, update)
      await expect(
        verifyHostNotePolicy(
          sourceCopy(['    followUpHostNotesEnabled,\n    now:', '    now:']),
          false,
          update,
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  it.each([false, true])(
    'detects removal of the product registry host-note switch for update=%s',
    async (update) => {
      await verifyHostNotePolicy(productSourceCopy(), false, update)
      await expect(
        verifyHostNotePolicy(
          productSourceCopy([
            '      followUpHostNotesEnabled,\n      successRedirectPolicy,',
            '      successRedirectPolicy,',
          ]),
          false,
          update,
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  async function verifyCreate(factory: Factory, teamRole?: string) {
    const s = await setup(factory, teamRole)
    const created = ok(await s.call('create_event_type', createInput()))
    expect(created).toMatchObject({ durationMinutes: 30, allowedDurationsMinutes: [15, 30, 60] })
    expect(
      await db
        .selectFrom('event_types')
        .select(['duration_minutes', 'allowed_durations_minutes', 'owner_user_id'])
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      duration_minutes: 30,
      allowed_durations_minutes: [15, 30, 60],
      owner_user_id: teamRole ? null : s.caller.user.id,
    })
  }
  async function verifyUpdate(factory: Factory, teamRole?: string) {
    const s = await setup(factory, teamRole)
    const created = await scheduling.createEventType(
      { db, principal: s.caller, now: () => Temporal.Now.instant() },
      createInput(),
    )
    const updated = ok(
      await s.call('update_event_type', {
        id: created.id,
        durationMinutes: 60,
        allowedDurationsMinutes: [90, 60, 30],
      }),
    )
    expect(updated).toMatchObject({ durationMinutes: 60, allowedDurationsMinutes: [30, 60, 90] })
    expect(updated).toHaveProperty('title', created.title)
    expect(updated).toHaveProperty('roundRobinActive', false)
    const persisted = await s.app.request(`/api/v1/event-types/${created.id}`, {
      headers: { authorization: 'Bearer hm_synthetic' },
    })
    expect(persisted.status).toBe(200)
    expect(await persisted.json()).toEqual(updated)
  }

  it.each([undefined, 'owner', 'admin'])(
    'creates and updates personal/team role %s with REST-identical saved durations',
    async (role) => {
      await verifyCreate(eventTypeTools, role)
      await verifyUpdate(eventTypeTools, role)
    },
  )

  it('preserves omitted settings and the single-length default update contract', async () => {
    const s = await setup()
    const { allowedDurationsMinutes: _allowed, ...input } = createInput()
    const created = ok(await s.call('create_event_type', input))
    expect(created.allowedDurationsMinutes).toEqual([30])
    const changed = ok(await s.call('update_event_type', { id: created.id, durationMinutes: 45 }))
    expect(changed).toMatchObject({ durationMinutes: 45, allowedDurationsMinutes: [45] })
    ok(await s.call('update_event_type', { id: created.id, allowedDurationsMinutes: [15, 30, 45] }))
    const defaultOnly = ok(
      await s.call('update_event_type', { id: created.id, durationMinutes: 15 }),
    )
    expect(defaultOnly).toMatchObject({
      durationMinutes: 15,
      allowedDurationsMinutes: [15, 30, 45],
    })
    expect(
      error(await s.call('update_event_type', { id: created.id, durationMinutes: 90 })),
    ).toEqual({
      error: 'invalid_event_type',
      message: 'allowedDurationsMinutes must include durationMinutes',
    })
  })

  it('accepts twelve choices and both documented minute bounds', async () => {
    const s = await setup()
    const allowedDurationsMinutes = [1, 15, 30, 45, 60, 75, 90, 120, 180, 240, 300, 1440]
    const created = ok(
      await s.call('create_event_type', {
        ...createInput(),
        durationMinutes: 1440,
        allowedDurationsMinutes,
      }),
    )
    expect(created).toMatchObject({ durationMinutes: 1440, allowedDurationsMinutes })
    const updated = ok(await s.call('update_event_type', { id: created.id, durationMinutes: 1 }))
    expect(updated).toMatchObject({ durationMinutes: 1, allowedDurationsMinutes })
  })

  it('matches REST duration validation codes and messages for create and update', async () => {
    const s = await setup()
    const created = ok(await s.call('create_event_type', createInput()))
    for (const changes of [
      { allowedDurationsMinutes: [] },
      { allowedDurationsMinutes: Array.from({ length: 13 }, (_, i) => i + 30) },
      { allowedDurationsMinutes: [30, 30] },
      { allowedDurationsMinutes: [15] },
      { allowedDurationsMinutes: [0, 30] },
      { allowedDurationsMinutes: [30, 1441] },
      { allowedDurationsMinutes: [30, 1.5] },
      { allowedDurationsMinutes: null },
      { durationMinutes: 0 },
      { durationMinutes: 1441 },
      { durationMinutes: 1.5 },
      { durationMinutes: '30' },
      { organizationId: randomUUID() },
    ]) {
      for (const update of [false, true]) {
        const body = update ? changes : { ...createInput(), ...changes }
        const response = await s.app.request(
          `/api/v1/event-types${update ? `/${created.id}` : ''}`,
          {
            method: update ? 'PATCH' : 'POST',
            headers: { authorization: 'Bearer hm_synthetic', 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        )
        expect(response.status).toBe(400)
        const result = error(
          await s.call(update ? 'update_event_type' : 'create_event_type', {
            ...(update ? { id: created.id } : {}),
            ...body,
          }),
        )
        expect(result).toEqual(await response.json())
      }
    }
  })

  it('retains team role, organization and ownership boundaries', async () => {
    const member = await setup(eventTypeTools, 'member')
    expect(error(await member.call('create_event_type', createInput())).error).toBe(
      'insufficient_role',
    )
    const owner = await setup()
    const created = ok(await owner.call('create_event_type', createInput()))
    expect(
      error(await member.call('update_event_type', { id: created.id, durationMinutes: 30 })).error,
    ).toBe('event_type_not_found')
    expect(
      error(
        await owner.call('create_event_type', {
          ...createInput(),
          ownerUserId: member.caller.user.id,
        }),
      ).error,
    ).toBe('invalid_request')
  })

  it('writes both duration fields through the real CLI and MCP transport', async () => {
    const s = await setup()
    async function cli(command: string, input: Record<string, unknown>) {
      let stdout = ''
      let stderr = ''
      const code = await runCli({
        argv: [command, '--input', '-'],
        env: { HOURMERE_URL: 'http://localhost:4189', HOURMERE_API_KEY: 'hm_synthetic' },
        stdin: (async function* () {
          yield JSON.stringify(input)
        })(),
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        fetch: async (input, init) => s.app.request(input, init),
      })
      return {
        code,
        data: stdout ? JSON.parse(stdout) : null,
        error: stderr ? JSON.parse(stderr) : null,
      }
    }
    const created = await cli('create-event', createInput())
    expect(created.code).toBe(0)
    expect(created.data).toMatchObject({
      durationMinutes: 30,
      allowedDurationsMinutes: [15, 30, 60],
    })
    const updated = await cli('update-event', {
      id: created.data.id,
      durationMinutes: 90,
      allowedDurationsMinutes: [90, 30],
    })
    expect(updated.code).toBe(0)
    expect(updated.data).toMatchObject({ durationMinutes: 90, allowedDurationsMinutes: [30, 90] })
    expect(
      await db
        .selectFrom('event_types')
        .select('allowed_durations_minutes')
        .where('id', '=', created.data.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ allowed_durations_minutes: [30, 90] })
    const invalid = await cli('update-event', {
      id: created.data.id,
      allowedDurationsMinutes: [30],
    })
    expect(invalid.code).toBe(1)
    expect(invalid.error.error).toBe('invalid_event_type')
  })

  it('exercises an unchanged source copy before the mutation controls', async () => {
    await verifyCreate(sourceCopy())
    await verifyUpdate(sourceCopy())
  })
  async function verifyInputShape(factory: Factory, update: boolean) {
    const s = await setup(factory)
    const created = await scheduling.createEventType(
      { db, principal: s.caller, now: () => Temporal.Now.instant() },
      createInput(),
    )
    expect(
      error(
        await s.call(update ? 'update_event_type' : 'create_event_type', {
          ...(update ? { id: created.id } : createInput()),
          durationMinutes: 1.5,
          allowedDurationsMinutes: [1.5, 30],
        }),
      ).error,
    ).toBe('invalid_request')
  }
  it.each([false, true])('detects weakened REST shape validation for update=%s', async (update) => {
    await verifyInputShape(sourceCopy(), update)
    const anchor = update ? 'input: EventTypeUpdate.extend({' : 'input: EventTypeInput,'
    const replacement = update
      ? 'input: EventTypeUpdate.extend({ durationMinutes: z.any(), allowedDurationsMinutes: z.any(),'
      : 'input: EventTypeInput.extend({ durationMinutes: z.any(), allowedDurationsMinutes: z.any() }),'
    await expect(verifyInputShape(sourceCopy([anchor, replacement]), update)).rejects.toMatchObject(
      {
        name: 'AssertionError',
      },
    )
  })
  it.each<[string, Change, (factory: Factory) => Promise<void>]>([
    [
      'create allowed lengths',
      [
        'return createEventType(context(call.caller), args)',
        'return createEventType(context(call.caller), { ...args, allowedDurationsMinutes: undefined })',
      ],
      verifyCreate,
    ],
    [
      'create default',
      [
        'return createEventType(context(call.caller), args)',
        'return createEventType(context(call.caller), { ...args, durationMinutes: 15 })',
      ],
      verifyCreate,
    ],
    [
      'update allowed lengths',
      [
        'return updateEventType(context(call.caller), id, changes)',
        'return updateEventType(context(call.caller), id, { ...changes, allowedDurationsMinutes: undefined })',
      ],
      verifyUpdate,
    ],
    [
      'update default',
      [
        'return updateEventType(context(call.caller), id, changes)',
        'return updateEventType(context(call.caller), id, { ...changes, durationMinutes: undefined })',
      ],
      verifyUpdate,
    ],
  ])(
    'detects removal of %s forwarding with a real assertion failure',
    async (_name, change, verify) => {
      await expect(verify(sourceCopy(change))).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
})
