import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FOLLOW_UP_HOST_NOTE_MAX_LENGTH } from '@hourmere/core/follow-up-note'
import type { Db } from '@hourmere/db'
import { REMINDER_LEAD, REMINDER_MIN_GAP } from '@hourmere/notifications'
import {
  DEFAULT_NOTIFICATIONS,
  validateNotifications,
} from '@hourmere/scheduling/notification-settings'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import { COMMANDS, runCli } from '../../../tools/cli/src/cli.ts'
import { catalogTools } from '../../server/src/mcp/catalog.ts'
import { openApiDocument } from '../../server/src/openapi-document.ts'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const siteDocs = 'apps/site/src/content/docs/docs'
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const guide = () => read(`${siteDocs}/reminders-and-follow-ups.md`)
const prose = (source: string) => source.replace(/[*`]/g, '').replace(/\s+/g, ' ')
const section = (source: string, heading: string) =>
  source.split(`### ${heading}\n`)[1]?.split(/\n###? /)[0] ?? ''

const facts = [
  {
    name: 'default policy',
    check(source: string) {
      const policy = DEFAULT_NOTIFICATIONS
      expect(policy.reminders).toHaveLength(1)
      expect(policy.followUps).toHaveLength(0)
      expect(policy.reminders[0]?.offsetMinutes).toBe(REMINDER_LEAD.hours * 60)
      expect(policy.reminders[0]?.recipients).toEqual({ invitee: true, guests: true, host: true })
      expect(prose(source)).toContain(`one reminder ${REMINDER_LEAD.hours} hours before`)
      expect(prose(source)).toContain('no follow-ups')
    },
    before: 'no follow-ups',
    after: 'one follow-up',
  },
  {
    name: 'strict post-booking gap and equality boundary',
    check(source: string) {
      const gap = REMINDER_MIN_GAP.hours === 1 ? 'one hour' : `${REMINDER_MIN_GAP.hours} hours`
      expect(prose(source)).toContain(`more than ${gap} after booking or rescheduling`)
      expect(prose(source)).toContain(
        `skipped when a booking is made exactly ${REMINDER_LEAD.hours + REMINDER_MIN_GAP.hours} hours before`,
      )
      expect(prose(source)).toContain('never sent late to catch up')
    },
    before: 'more than one hour',
    after: 'at least one hour',
  },
  {
    name: 'host-note UTF-16 bound',
    check(source: string) {
      expect(prose(source)).toContain(`${FOLLOW_UP_HOST_NOTE_MAX_LENGTH} UTF-16 code units`)
      expect(prose(source)).toContain('many emoji use two')
    },
    before: '2000',
    after: '2001',
  },
  {
    name: 'immutable reschedule policy',
    check(source: string) {
      expect(prose(source)).toContain('Rescheduling keeps those original settings')
    },
    before: 'Rescheduling keeps those original settings',
    after: 'Rescheduling loads the current event-type settings',
  },
  {
    name: 'scheduled-end semantics',
    check(source: string) {
      expect(prose(source)).toContain('scheduled end, regardless of attendance')
    },
    before: 'scheduled end',
    after: 'actual end',
  },
  {
    name: 'body-only host notes',
    check(source: string) {
      expect(prose(source)).toContain('The note appears only in the email body.')
    },
    before: 'only in the email body',
    after: 'in the subject and email body',
  },
  {
    name: 'saved-note suppression while disabled',
    check(source: string) {
      expect(prose(source)).toContain('FOLLOW_UP_HOST_NOTES_ENABLED=false')
      expect(prose(source)).toContain('retained but omitted from emails while notes are disabled')
    },
    before: 'retained but omitted from emails',
    after: 'retained and included in emails',
  },
  {
    name: 'calendar-decline independence',
    check(source: string) {
      expect(prose(source)).toContain('does not cancel the Hourmere booking or stop its messages')
    },
    before: 'does not cancel the Hourmere',
    after: 'cancels the Hourmere',
  },
  {
    name: 'permanent budget suppression',
    check(source: string) {
      expect(prose(source)).toContain('skipped permanently for that recipient')
      expect(prose(source)).toContain('never caught up after capacity returns')
    },
    before: 'never caught up after capacity returns',
    after: 'queued until capacity returns',
  },
]

function examples(source: string) {
  const rest = section(source, 'REST')
  const mcp = section(source, 'MCP')
  const cli = section(source, 'CLI')
  // Replace only the documented UUID placeholder, exactly as the reader is instructed.
  const parse = (text: string | undefined) => {
    expect(text).toBeDefined()
    return JSON.parse(
      (text ?? '').replaceAll('<event-type-id>', '00000000-0000-4000-8000-000000000001'),
    )
  }
  return {
    rest,
    body: parse(rest.match(/-d '([^']+)'/)?.[1]),
    args: parse(mcp.match(/```json\n([\s\S]*?)\n```/)?.[1]),
    cli,
    cliArgs: parse(cli.match(/<<'JSON'\n([\s\S]*?)\nJSON/)?.[1]),
  }
}

describe('reminder and follow-up documentation', () => {
  for (const fact of facts) {
    it(`documents ${fact.name}`, () => fact.check(guide()))
    it(`rejects a changed source copy of ${fact.name}`, () => {
      const source = guide()
      expect(source).toContain(fact.before)
      expect(() => fact.check(source.replaceAll(fact.before, fact.after))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    })
  }

  it('keeps the host guide discoverable and lists known limitations explicitly', () => {
    for (const path of ['index', 'notifications', 'comparison', 'rest', 'mcp', 'cli']) {
      expect(read(`${siteDocs}/${path}.md`), path).toContain('](/docs/reminders-and-follow-ups)')
    }
    expect(guide().split('## Known limitations\n')[1]).toMatch(/^- /m)
  })

  it('validates the REST example against the published OpenAPI request schema', async () => {
    const document = (await openApiDocument()) as {
      components: Record<string, unknown>
      paths: Record<
        string,
        { put: { requestBody: { content: Record<string, { schema: object }> } } }
      >
    }
    const path = '/api/v1/event-types/{id}/notifications'
    const schema = document.paths[path]?.put.requestBody.content['application/json']?.schema
    expect(schema).toBeDefined()
    const ajv = new Ajv({ strict: false })
    addFormats(ajv)
    const validate = ajv.compile({ ...schema, components: document.components })
    const check = (source: string) => {
      const { rest, body } = examples(source)
      expect(rest).toContain('-X PUT')
      expect(rest).toContain(path.replace('{id}', '<event-type-id>'))
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true)
      expect(() => validateNotifications(body.notifications)).not.toThrow()
    }
    check(guide())
    for (const [before, after] of [
      ['-X PUT', '-X PATCH'],
      ['<event-type-id>/notifications', '<event-type-id>/reminders'],
      ['"offsetMinutes":120', '"offsetMinutes":0'],
    ] as const) {
      expect(guide()).toContain(before)
      expect(() => check(guide().replaceAll(before, after))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    }
  })

  it('validates the MCP example against its real schema and shared service rules', () => {
    // Constructing tools does not execute handlers or open database connections.
    const tool = catalogTools({ db: {} as Db }).find(
      (tool) => tool.name === 'set_event_type_notifications',
    )
    expect(tool).toBeDefined()
    const check = (source: string) => {
      const { args, body } = examples(source)
      expect(section(source, 'MCP')).toContain('`set_event_type_notifications`')
      expect(tool?.input.safeParse(args).success).toBe(true)
      expect(args.notifications).toEqual(body.notifications)
      expect(() => validateNotifications(args.notifications)).not.toThrow()
    }
    check(guide())
    const before = '"id": "<event-type-id>"'
    expect(guide()).toContain(before)
    expect(() => check(guide().replaceAll(before, '"eventTypeId": "<event-type-id>"'))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    expect(() =>
      check(
        guide().replaceAll(
          'Thank you for your time.',
          'x'.repeat(FOLLOW_UP_HOST_NOTE_MAX_LENGTH + 1),
        ),
      ),
    ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })

  it('runs the documented CLI flags and JSON through the real parser with a fake transport', async () => {
    const check = async (source: string) => {
      const { cli, cliArgs, args } = examples(source)
      const command = cli.match(/npm run --silent cli -- (.+) <<'JSON'/)?.[1]
      expect(command).toBeDefined()
      expect(cliArgs).toEqual(args)
      let calls = 0
      const stderr: string[] = []
      const status = await runCli({
        argv: (command ?? '').split(/\s+/),
        env: {
          HOURMERE_URL: 'https://hourmere.example.com',
          HOURMERE_API_KEY: 'hm_synthetic_docs',
        },
        stdin: (async function* () {
          yield JSON.stringify(cliArgs)
        })(),
        stdout: () => {},
        stderr: (text) => stderr.push(text),
        fetch: async (url, init) => {
          calls++
          expect(String(url)).toBe('https://hourmere.example.com/mcp')
          const request = JSON.parse(String(init?.body))
          expect(request.params.name).toBe(COMMANDS['set-event-notifications'])
          expect(request.params.arguments).toEqual(args)
          return Response.json({
            jsonrpc: '2.0',
            id: 1,
            result: { structuredContent: {}, content: [] },
          })
        },
      })
      expect(stderr).toEqual([])
      expect(status).toBe(0)
      expect(calls).toBe(1)
    }
    await check(guide())
    await expect(check(guide().replace('--input -', '--offset-minutes 120'))).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
