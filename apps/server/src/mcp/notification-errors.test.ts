// Real REST and MCP handlers plus the CLI client share one throwaway database.
import '@hono/zod-openapi'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DEFAULT_NOTIFICATIONS } from '@hourmere/scheduling'
import { createFixtures, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import { eventTypeRoutes } from '../routes/event-types.ts'
import { catalogTools } from './catalog.ts'
import { mcpEndpoint } from './endpoint.ts'

const bootstrap = process.env.DATABASE_URL
const origin = 'http://localhost:4188'
const key = 'hm_notification_validation_synthetic'
const rule = (id = 'rule', offsetMinutes = 60) => ({
  id,
  offsetMinutes,
  recipients: { invitee: true, guests: false, host: false },
})
const cases: [string, unknown, string, boolean?][] = [
  [
    'reminder count',
    { reminders: Array.from({ length: 6 }, (_, i) => rule(`r${i}`, 5 + i)), followUps: [] },
    'notifications.reminders: at most 5 messages are allowed',
  ],
  [
    'follow-up count',
    { reminders: [], followUps: Array.from({ length: 4 }, (_, i) => rule(`f${i}`, 5 + i)) },
    'notifications.followUps: at most 3 messages are allowed',
  ],
  [
    'ID grammar',
    { reminders: [rule('valid', 10), rule('bad id')], followUps: [] },
    'notifications.reminders[1].id: must be 1–64 letters, digits, "_" or "-"',
  ],
  [
    'reserved ID',
    { reminders: [], followUps: [rule('__proto__')] },
    'notifications.followUps[0].id: must not be __proto__',
  ],
  [
    'ID uniqueness',
    { reminders: [rule()], followUps: [rule()] },
    'notifications.followUps[0].id: must be unique across reminders and followUps',
  ],
  [
    'integer offset',
    { reminders: [], followUps: [rule('valid', 120), rule('invalid', 5.5)] },
    'notifications.followUps[1].offsetMinutes: must be an integer number of minutes',
  ],
  ...[4, 43201].map((offset): [string, unknown, string] => [
    `offset ${offset}`,
    { reminders: [rule('valid', 10), rule('invalid', offset)], followUps: [] },
    'notifications.reminders[1].offsetMinutes: must be between 5 and 43200 minutes',
  ]),
  [
    'offset uniqueness',
    { reminders: [], followUps: [rule('first'), rule('second')] },
    'notifications.followUps[1].offsetMinutes: must be unique within this message category',
  ],
  [
    'recipient selection',
    {
      reminders: [{ ...rule(), recipients: { invitee: false, guests: false, host: false } }],
      followUps: [],
    },
    'notifications.reminders[0].recipients: at least one recipient must be selected',
  ],
  [
    'note length',
    {
      reminders: [],
      followUps: [rule('valid', 120), { ...rule(), hostNote: 'private-note'.repeat(200) }],
    },
    'notifications.followUps[1].hostNote: must contain at most 2000 UTF-16 code units',
  ],
  [
    'note UTF-16 length',
    { reminders: [], followUps: [{ ...rule(), hostNote: '🙂'.repeat(1001) }] },
    'notifications.followUps[0].hostNote: must contain at most 2000 UTF-16 code units',
  ],
  [
    'note controls',
    { reminders: [], followUps: [{ ...rule(), hostNote: 'private-note\tcontent' }] },
    'notifications.followUps[0].hostNote: must not contain control characters other than LF',
  ],
  [
    'disabled note',
    { reminders: [], followUps: [rule('valid', 120), { ...rule(), hostNote: 'private-note' }] },
    'notifications.followUps[1].hostNote: host notes are disabled by the operator',
    false,
  ],
]

describe.skipIf(!bootstrap)('notification error details across REST, MCP and CLI', () => {
  let owned: TestDatabase
  let db: Db
  let user: TestUser
  let id: string
  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string)
    db = createDb(owned.pool)
    user = await createTestUser(db)
    id = await createFixtures(db).eventType(user.principal.organization.id, user.id)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it.each(cases)(
    'returns the same value-free path and constraint for %s',
    async (_, notifications, message, followUpHostNotesEnabled = true) => {
      const app = createApp({
        publicUrl: origin,
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: true, principal: user.principal, setCookie: [] }),
        routes: [eventTypeRoutes({ db, followUpHostNotesEnabled })],
        mcp: mcpEndpoint({ tools: catalogTools({ db, followUpHostNotesEnabled }) }),
      })
      const expected = { error: 'invalid_notifications', message }
      for (const [method, path, body] of [
        [
          'POST',
          '/api/v1/event-types',
          {
            slug: 'invalid-notification',
            title: 'Invalid notification',
            durationMinutes: 30,
            notifications,
          },
        ],
        ['PATCH', `/api/v1/event-types/${id}`, { notifications }],
        ['PUT', `/api/v1/event-types/${id}/notifications`, { notifications }],
      ] as const) {
        const response = await app.request(path, {
          method,
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual(expected)
      }
      const client = new Client({ name: 'notification-error-test', version: '1.0.0' })
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            fetch: async (input, init) => app.request(input, init),
            requestInit: { headers: { authorization: `Bearer ${key}` } },
          }),
        )
        const result = await client.callTool({
          name: 'set_event_type_notifications',
          arguments: { id, notifications },
        })
        expect(result.isError).toBe(true)
        const content = result.content as { text: string }[]
        expect(JSON.parse(content[0]?.text ?? 'null')).toEqual(expected)
      } finally {
        await client.close()
      }
      let stdout = ''
      let stderr = ''
      const code = await runCli({
        argv: ['set-event-notifications', '--input', '-'],
        env: { HOURMERE_URL: origin, HOURMERE_API_KEY: key },
        stdin: (async function* () {
          yield JSON.stringify({ id, notifications })
        })(),
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        fetch: async (input, init) => app.request(input, init),
      })
      expect(code).toBe(1)
      expect(stdout).toBe('')
      expect(JSON.parse(stderr)).toMatchObject(expected)
      expect(stderr).not.toContain('private-note')
      const row = await db
        .selectFrom('event_types')
        .select('notifications')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(row.notifications).toEqual(DEFAULT_NOTIFICATIONS)
    },
  )
})
