import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from '@hourmere/db'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import * as Retention from '../../../packages/jobs/src/one-time-links-retention.ts'
import * as Links from '../../../packages/scheduling/src/one-time-links.ts'
import { COMMANDS, runCli } from '../../../tools/cli/src/cli.ts'
import { oneTimeLinkTools } from '../../server/src/mcp/one-time-links.ts'
import { openApiDocument } from '../../server/src/openapi-document.ts'
import { admin } from '../../web/src/i18n/catalogues/en/admin.ts'
import { common } from '../../web/src/i18n/catalogues/en/common.ts'
import { ONE_TIME_LINK_EXPIRIES } from '../../web/src/pages/event-types/one-time-link-options.ts'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const siteDocs = 'apps/site/src/content/docs/docs'
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const guide = () => read(`${siteDocs}/one-time-links.md`)
const prose = (source: string) => source.replace(/[*`]/g, '').replace(/\s+/g, ' ')
const section = (source: string, heading: string) =>
  source.split(`## ${heading}\n`)[1]?.split(/\n## /)[0] ?? ''
const assertion = expect.objectContaining({ name: 'AssertionError' })

const numericFacts = [
  {
    name: 'owner and team capacity',
    module: 'packages/scheduling/src/one-time-links.ts',
    key: 'ONE_TIME_BOOKING_LINK_LIMIT',
    value: Links.ONE_TIME_BOOKING_LINK_LIMIT,
    phrase: (value: number) => `${value} active, unexpired links per personal owner or team`,
  },
  {
    name: 'ordinary team member capacity',
    module: 'packages/scheduling/src/one-time-links.ts',
    key: 'ONE_TIME_BOOKING_LINK_MEMBER_LIMIT',
    value: Links.ONE_TIME_BOOKING_LINK_MEMBER_LIMIT,
    phrase: (value: number) => `${value}-link allowance`,
  },
  {
    name: 'default history page size',
    module: 'packages/scheduling/src/one-time-links.ts',
    key: 'ONE_TIME_LINK_PAGE_DEFAULT',
    value: Links.ONE_TIME_LINK_PAGE_DEFAULT,
    phrase: (value: number) => `Listing defaults to ${value} rows`,
  },
  {
    name: 'minimum history page size',
    module: 'packages/scheduling/src/one-time-links.ts',
    key: 'ONE_TIME_LINK_PAGE_MIN',
    value: Links.ONE_TIME_LINK_PAGE_MIN,
    phrase: (value: number) => `limit from ${value} to`,
  },
  {
    name: 'maximum history page size',
    module: 'packages/scheduling/src/one-time-links.ts',
    key: 'ONE_TIME_LINK_PAGE_MAX',
    value: Links.ONE_TIME_LINK_PAGE_MAX,
    phrase: (value: number) => `limit from ${Links.ONE_TIME_LINK_PAGE_MIN} to ${value}`,
  },
  {
    name: 'prefill name bound',
    module: 'packages/scheduling/src/one-time-links.ts',
    key: 'ONE_TIME_LINK_PREFILL_NAME_MAX',
    value: Links.ONE_TIME_LINK_PREFILL_NAME_MAX,
    phrase: (value: number) => `names allow up to ${value} characters`,
  },
  {
    name: 'prefill email bound',
    module: 'packages/scheduling/src/one-time-links.ts',
    key: 'ONE_TIME_LINK_PREFILL_EMAIL_MAX',
    value: Links.ONE_TIME_LINK_PREFILL_EMAIL_MAX,
    phrase: (value: number) => `email addresses up to ${value}`,
  },
  {
    name: 'unused cleanup grace',
    module: 'packages/jobs/src/one-time-links-retention.ts',
    key: 'ONE_TIME_LINK_RETENTION_DAYS',
    value: Retention.ONE_TIME_LINK_RETENTION_DAYS,
    phrase: (value: number) => `once ${value} days have passed since expiry or revocation`,
  },
  {
    name: 'combined cleanup batch cap',
    module: 'packages/jobs/src/one-time-links-retention.ts',
    key: 'ONE_TIME_LINK_CLEANUP_BATCH',
    value: Retention.ONE_TIME_LINK_CLEANUP_BATCH,
    phrase: (value: number) => `${value} unused links per run`,
  },
]

const lifecycleFacts = [
  {
    name: 'hidden event type distinction',
    phrase: 'its ordinary direct booking address is reusable',
    mutation: 'its ordinary direct booking address is single use',
  },
  {
    name: 'shown-once recovery',
    phrase: 'revoke the unused link and create another',
    mutation: 'recover the unused link from the list',
  },
  {
    name: 'prefill identity boundary',
    phrase: 'Prefill is not identity proof',
    mutation: 'Prefill verifies invitee identity',
  },
  {
    name: 'no reactivation on cancellation or rescheduling',
    phrase: 'Cancelling or rescheduling never reactivates the original one-time link',
    mutation: 'Cancelling or rescheduling reactivates the original one-time link',
  },
  {
    name: 'team ownership after creator departure',
    phrase: 'stays with the team after its creator leaves or deletes their account',
    mutation: 'is deleted when its creator leaves or deletes their account',
  },
  {
    name: 'revocation and booking race outcomes',
    phrase:
      'either the booking commits and the link stays used, or revocation wins and the booking is refused',
    mutation: 'both revocation and booking may commit successfully',
  },
  {
    name: 'expiry equality boundary',
    phrase: 'At the exact expiry instant the link is unavailable',
    mutation: 'At the exact expiry instant the link is available',
  },
  {
    name: 'used evidence retention',
    phrase: 'Used links are never deleted by this cleanup',
    mutation: 'Used links are deleted by this cleanup',
  },
  {
    name: 'no-referrer response policy',
    phrase: 'Referrer-Policy: no-referrer',
    mutation: 'Referrer-Policy: origin',
  },
]

const parse = (text: string) =>
  JSON.parse(
    text
      .replaceAll('<event-type-id>', '00000000-0000-4000-8000-000000000001')
      .replaceAll('<link-id>', '00000000-0000-4000-8000-000000000002')
      .replaceAll('<new-random-UUID>', '00000000-0000-4000-8000-000000000003'),
  )
const jsonBlocks = (source: string) =>
  [...source.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => parse(match[1] ?? ''))
const tools = oneTimeLinkTools({ db: {} as Db })
const actions = ['create', 'list', 'revoke'] as const

/** Evaluate changed declarations from source copies without loading I/O dependencies. */
async function changedConstant(path: string, key: string, before: number, after: number) {
  const declaration = `export const ${key} = ${before}`
  const source = read(path)
  expect(source).toContain(declaration)
  const changed = declaration.replace(`= ${before}`, `= ${after}`)
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`
  )
  return module[key] as number
}

function checkPresets(source: string, options = ONE_TIME_LINK_EXPIRIES) {
  for (const option of options) {
    expect(source).toContain(`| ${option.label} | ${option.value || 'No expiry'} |`)
  }
  expect(prose(source)).toContain('presets, not minimum or maximum expiry bounds for REST or MCP')
  expect(prose(source)).toContain('exactly 24 elapsed hours')
  expect(prose(source)).toContain('no minimum lead time or maximum lifetime policy')
}

function checkMcp(source: string) {
  const mcp = section(source, 'MCP')
  const inputs = jsonBlocks(mcp)
  expect(inputs).toHaveLength(actions.length)
  for (const [index, action] of actions.entries()) {
    const name = `${action}_one_time_link${action === 'list' ? 's' : ''}`
    expect(mcp).toContain(`\`${name}\``)
    const tool = tools.find((tool) => tool.name === name)
    expect(tool, name).toBeDefined()
    expect(tool?.input.safeParse(inputs[index]).success, name).toBe(true)
  }
  const { eventTypeId: _eventTypeId, idempotencyKey: _key, ...createBody } = inputs[0]
  expect(createBody).toEqual(jsonBlocks(section(source, 'REST'))[0])
  return inputs
}

async function checkCli(source: string) {
  const cli = section(source, 'CLI')
  const examples = [...cli.matchAll(/npm run --silent cli -- (.+) <<'JSON'\n([\s\S]*?)\nJSON/g)]
  expect(examples).toHaveLength(actions.length)
  const mcpInputs = checkMcp(source)
  for (const [index, action] of actions.entries()) {
    const example = examples[index]
    expect(example?.[1]).toBe(`one-time-links ${action} --input -`)
    const input = parse(example?.[2] ?? '')
    expect(input).toEqual(mcpInputs[index])
    const stderr: string[] = []
    let calls = 0
    const status = await runCli({
      argv: (example?.[1] ?? '').split(/\s+/),
      env: {
        HOURMERE_URL: 'https://hourmere.example.com',
        HOURMERE_API_KEY: 'hm_synthetic_docs',
      },
      stdin: (async function* () {
        yield JSON.stringify(input)
      })(),
      stdout: () => {},
      stderr: (text) => stderr.push(text),
      fetch: async (url, init) => {
        calls++
        expect(String(url)).toBe('https://hourmere.example.com/mcp')
        const request = JSON.parse(String(init?.body))
        expect(request.params.name).toBe(COMMANDS[`one-time-links ${action}`])
        expect(request.params.arguments).toEqual(mcpInputs[index])
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
}

describe('one-time booking link documentation', () => {
  for (const fact of numericFacts) {
    const check = (source: string, value = fact.value) =>
      expect(prose(source)).toContain(fact.phrase(value))
    it(`documents the real ${fact.name}`, () => check(guide()))
    it(`detects changed source copies of the ${fact.name} constant and prose`, async () => {
      const source = guide()
      const before = fact.phrase(fact.value)
      const after = fact.phrase(fact.value + 1)
      // Normalize Markdown before changing a numeric phrase split by formatting/newlines.
      expect(() => check(prose(source).replaceAll(before, after))).toThrow(assertion)
      const value = await changedConstant(fact.module, fact.key, fact.value, fact.value + 1)
      expect(() => check(source, value)).toThrow(assertion)
      check(prose(source).replaceAll(before, after), value)
    })
  }

  for (const fact of lifecycleFacts) {
    const check = (source: string) => expect(prose(source)).toContain(fact.phrase)
    it(`documents ${fact.name}`, () => check(guide()))
    it(`rejects a changed source copy of ${fact.name}`, () => {
      const source = prose(guide())
      expect(() => check(source.replaceAll(fact.phrase, fact.mutation))).toThrow(assertion)
    })
  }

  it('uses the editor revocation button label and rejects stale wording', () => {
    const check = (source: string) =>
      expect(section(source, 'Create and revoke in the editor')).toContain(
        `choose **${admin['Revoke link']}**`,
      )
    check(guide())
    expect(() => check(guide().replace('**Revoke link**', '**Revoke**'))).toThrow(assertion)
  })

  it('documents the real editor expiry presets without claiming a TTL policy bound', () => {
    checkPresets(guide())
  })

  it('detects a changed source copy of editor expiry hours', async () => {
    const source = read('apps/web/src/pages/event-types/one-time-link-options.ts')
    expect(source).toContain("value: '720'")
    const changed = stripTypeScriptTypes(source.replace("value: '720'", "value: '744'"))
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`
    )
    expect(() => checkPresets(guide(), module.ONE_TIME_LINK_EXPIRIES)).toThrow(assertion)
  })

  it('documents the hourly cleanup schedule', () => {
    expect(Retention.ONE_TIME_LINK_CLEANUP_CRON).toBe('0 * * * *')
    expect(prose(guide())).toContain('An hourly cleanup')
  })

  it('uses the real neutral public title and lists all terminal states', () => {
    expect(guide()).toContain(`**${common['This booking link is unavailable']}**`)
    for (const state of ['active', 'used', 'expired', 'revoked']) {
      expect(section(guide(), 'States and revocation')).toContain(`| \`${state}\` |`)
    }
  })

  it('links proxy redaction, permissions and known limitations', () => {
    expect(guide()).toContain('](/docs/self-hosting#proxy-behavior-and-an-existing-proxy)')
    expect(read(`${siteDocs}/self-hosting.md`)).toContain('the token after `/book/`')
    expect(prose(section(guide(), 'Privacy'))).toContain('Hourmere never logs the token')
    expect(prose(section(guide(), 'Privacy'))).toContain(
      'redact the path token in access and error logs',
    )
    const scopes = section(guide(), 'Ownership and scopes')
    expect(prose(scopes)).toContain(
      'Create or revoke | Bookings (bookings) or Full account access (full)',
    )
    expect(prose(scopes)).toContain(
      'List or read metadata | Read (read) or Full account access (full)',
    )
    expect(prose(scopes)).toContain('OAuth mcp:tools grants can create, list and revoke')
    expect(section(guide(), 'Known limitations')).toMatch(/^- /m)
    const comparison = read(`${siteDocs}/comparison.md`)
    expect(comparison).toContain('](/docs/one-time-links)')
    expect(prose(comparison)).toContain(
      `${Links.ONE_TIME_BOOKING_LINK_LIMIT} active unexpired links`,
    )
    expect(prose(comparison)).toContain(
      `${Links.ONE_TIME_BOOKING_LINK_MEMBER_LIMIT}-link sub-limit`,
    )
  })

  it('validates REST methods, paths and JSON against the real OpenAPI document', async () => {
    const document = (await openApiDocument()) as {
      components: Record<string, unknown>
      paths: Record<
        string,
        {
          post?: { requestBody: { content: Record<string, { schema: object }> } }
          get?: object
          delete?: object
        }
      >
    }
    const path = '/api/v1/event-types/{eventTypeId}/one-time-links'
    const schema = document.paths[path]?.post?.requestBody.content['application/json']?.schema
    expect(schema).toBeDefined()
    const ajv = new Ajv({ strict: false })
    addFormats(ajv)
    const validate = ajv.compile({ ...schema, components: document.components })
    const check = (source: string) => {
      const rest = section(source, 'REST')
      expect(rest).toContain('-X POST')
      expect(rest).toContain('-X DELETE')
      expect(rest).toContain(path.replace('{eventTypeId}', '<event-type-id>'))
      expect(rest).toContain('--data-binary @one-time-request.json')
      for (const [method, route] of [
        ['post', path],
        ['get', path],
        ['get', `${path}/{id}`],
        ['delete', `${path}/{id}`],
      ] as const) {
        expect(document.paths[route]?.[method]).toBeDefined()
        expect(rest).toContain(`\`${method.toUpperCase()} ${route}\``)
      }
      expect(validate(jsonBlocks(rest)[0]), JSON.stringify(validate.errors)).toBe(true)
    }
    check(guide())
    for (const [before, after] of [
      ['-X POST', '-X PATCH'],
      ['<event-type-id>/one-time-links', '<event-type-id>/private-links'],
      ['"expiresAt": "2027-12-01T18:00:00Z"', '"expiresAt": "not-an-instant"'],
    ] as const) {
      expect(guide()).toContain(before)
      expect(() => check(guide().replaceAll(before, after))).toThrow(assertion)
    }
  })

  it('validates all MCP examples against real tool schemas', () => {
    checkMcp(guide())
    expect(() => checkMcp(guide().replaceAll('"eventTypeId":', '"eventId":'))).toThrow(assertion)
    expect(() =>
      checkMcp(guide().replaceAll('"limit": 50', `"limit": ${Links.ONE_TIME_LINK_PAGE_MAX + 1}`)),
    ).toThrow(assertion)
    expect(() => checkMcp(guide().replaceAll('"idempotencyKey":', '"retryKey":'))).toThrow(
      assertion,
    )
  })

  it('runs every documented CLI command with the real parser and a fake transport', async () => {
    await checkCli(guide())
    await expect(checkCli(guide().replace('--input -', '--expiry 24'))).rejects.toThrow(assertion)
    await expect(
      checkCli(guide().replace('one-time-links revoke', 'one-time-link revoke')),
    ).rejects.toThrow(assertion)
  })
})
