import '@hono/zod-openapi'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import {
  WAITLIST_ABUSE_RETENTION_DAYS,
  WAITLIST_SLOT_RETENTION_DAYS,
  WAITLIST_WINDOW_MAX_DAYS,
} from '../../../packages/scheduling/src/waitlist-policy.ts'
import { COMMANDS, runCli } from '../../../tools/cli/src/cli.ts'
import { waitlistTools } from '../../server/src/mcp/waitlist.ts'
import { openApiDocument } from '../../server/src/openapi-document.ts'

const Policy = {
  WAITLIST_WINDOW_MAX_DAYS,
  WAITLIST_ABUSE_RETENTION_DAYS,
  WAITLIST_SLOT_RETENTION_DAYS,
}
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const guide = read('./content/docs/docs/booking-waitlist.md')
const prose = (source: string) => source.replace(/[*`]/g, '').replace(/\s+/g, ' ')
const assertion = expect.objectContaining({ name: 'AssertionError' })
const facts = [
  ['WAITLIST_WINDOW_MAX_DAYS', (value: number) => `at most ${value} days into the future`],
  ['WAITLIST_ABUSE_RETENTION_DAYS', (value: number) => `records remain for ${value} days`],
  ['WAITLIST_SLOT_RETENTION_DAYS', (value: number) => `slot ends plus ${value} days`],
] as const

function checkRetention(source: string, policy = Policy) {
  for (const [key, phrase] of facts) expect(prose(source)).toContain(phrase(policy[key]))
  expect(prose(source)).toContain(
    `up to ${policy.WAITLIST_WINDOW_MAX_DAYS + policy.WAITLIST_SLOT_RETENTION_DAYS} days from admission`,
  )
}

describe('booking waitlist documentation facts', () => {
  it('pins admission and both hashed retention periods to runtime policy constants', () => {
    checkRetention(guide)
    expect(() => checkRetention(guide.replace('up to 64 days', 'up to 63 days'))).toThrow(assertion)
  })

  for (const [key, phrase] of facts) {
    it(`rejects changed source copies of ${key} and its documented value`, async () => {
      const original = read('../../../packages/scheduling/src/waitlist-policy.ts')
      const declaration = `export const ${key} = ${Policy[key]}`
      expect(original).toContain(declaration)
      const changed = stripTypeScriptTypes(
        original.replace(declaration, `export const ${key} = ${Policy[key] + 1}`),
      )
      const mutated = await import(
        `data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`
      )
      expect(() => checkRetention(guide, mutated)).toThrow(assertion)
      expect(() =>
        checkRetention(prose(guide).replace(phrase(Policy[key]), phrase(Policy[key] + 1))),
      ).toThrow(assertion)
    })
  }

  it('keeps policy constants wired to admission and cleanup rather than documentary aliases', () => {
    const admission = read('../../../packages/scheduling/src/waitlist.ts')
    expect(admission).toContain('now.getTime() + WAITLIST_WINDOW_MAX_DAYS * DAY')
    expect(admission).toContain('end.getTime() - start.getTime() > WAITLIST_WINDOW_MAX_DAYS * DAY')
    expect(admission).toContain('now.getTime() - WAITLIST_ABUSE_RETENTION_DAYS * DAY')
    expect(read('../../../packages/scheduling/src/waitlist-discovery.ts')).toContain(
      'slotEnd + WAITLIST_SLOT_RETENTION_DAYS * 86_400_000',
    )
  })

  for (const phrase of [
    'Everyone eligible is notified, nothing is reserved, and the first successful ordinary booking wins.',
    'Leaving, host removal and disabling immediately clear contact details and revoke pending work.',
    'Only one-on-one event types with a single host are eligible.',
    'Re-enabling does not restore removed entries.',
    'SMTP acceptance, not inbox delivery',
  ]) {
    it(`retains the lifecycle contract: ${phrase}`, () => {
      const check = (source: string) => expect(prose(source)).toContain(phrase)
      check(guide)
      expect(() => check(prose(guide).replace(phrase, 'Removed guarantee.'))).toThrow(assertion)
    })
  }

  it('documents the actual full-waitlist UI response', () => {
    const phrase = 'This waitlist is full (100 entries). Please check available times later.'
    const check = (runtime: string, docs: string) => {
      expect(runtime).toContain(phrase)
      expect(prose(docs)).toContain(phrase)
    }
    const runtime = read('../../web/src/public/WaitlistJoin.tsx')
    check(runtime, guide)
    expect(() => check(runtime.replace(phrase, 'Check your email'), guide)).toThrow(assertion)
    expect(() => check(runtime, guide.replace(phrase, 'Check your email'))).toThrow(assertion)
  })

  it('names the secret and its waitlist rotation effect in both operator guides', () => {
    const check = (source: string) => {
      expect(source).toContain('BETTER_AUTH_SECRET')
      expect(prose(source)).toContain('clears all waitlist entries')
    }
    for (const source of [guide, read('./content/docs/docs/configuration.md')]) {
      check(source)
      expect(() => check(source.replaceAll('BETTER_AUTH_SECRET', 'OTHER_SECRET'))).toThrow(
        assertion,
      )
      expect(() =>
        check(source.replace('clears all waitlist entries', 'preserves entries')),
      ).toThrow(assertion)
    }
  })

  it('pins the remaining lifecycle bounds to their runtime expressions', () => {
    for (const [path, expression, phrase] of [
      [
        '../../../packages/notifications/src/waitlist.ts',
        "if (!deps.smtpConfigured) return finish(db, claim, row, 'failed', at, 'smtp_not_configured')",
        'Waitlists require SMTP (SMTP_URL and MAIL_FROM)',
      ],
      [
        '../../../packages/scheduling/src/waitlist.ts',
        'Number(count.n) >= 100',
        'at most 100 active entries',
      ],
      [
        '../../../packages/scheduling/src/waitlist.ts',
        'now.getTime() + 30 * 60_000',
        'links last up to 30 minutes',
      ],
      [
        '../../../packages/scheduling/src/waitlist.ts',
        'pending_expires_at: new Date(Math.min(now.getTime() + DAY, expiresAt.getTime()))',
        'Pending enrollment lasts at most 24 hours',
      ],
      [
        '../../../packages/scheduling/src/waitlist.ts',
        'const DAY = 24 * HOUR',
        'Pending enrollment lasts at most 24 hours',
      ],
      [
        '../../../packages/scheduling/src/waitlist.ts',
        'now.getTime() + 30 * DAY',
        '30 days after joining',
      ],
      [
        '../../../packages/scheduling/src/waitlist.ts',
        ".where('terminal_at', '<=', new Date(now.getTime() - 7 * DAY))",
        'metadata is retained for 7 days',
      ],
      [
        '../../../packages/scheduling/src/waitlist-discovery.ts',
        'if (selected.length === 3) break',
        'up to three matching times',
      ],
    ]) {
      const check = (runtime: string, docs: string) => {
        expect(runtime).toContain(expression)
        expect(prose(docs)).toContain(phrase)
      }
      const runtime = read(path ?? '')
      check(runtime, guide)
      expect(() => check(runtime.replace(expression ?? '', 'changed bound'), guide)).toThrow(
        assertion,
      )
      expect(() => check(runtime, prose(guide).replace(phrase ?? '', 'changed bound'))).toThrow(
        assertion,
      )
    }
    const input = waitlistTools({ db: {} as Db }).find(
      (tool) => tool.name === 'list_waitlist_entries',
    )?.input
    const id = '00000000-0000-4000-8000-000000000001'
    expect(input?.safeParse({ id, limit: 100 }).success).toBe(true)
    expect(input?.safeParse({ id, limit: 101 }).success).toBe(false)
    expect(input?.safeParse({ id, limit: 0 }).success).toBe(false)
    expect(guide).toContain('(1–100)')
  })

  it('lists only real REST paths and methods, including both public page variants', async () => {
    const document = (await openApiDocument()) as { paths: Record<string, Record<string, unknown>> }
    const rows = [...guide.matchAll(/`(GET|PUT|POST|DELETE) (\/api\/v1\/[^`]+)`/g)]
    expect(rows.length).toBeGreaterThanOrEqual(6)
    for (const [, method, path] of rows) {
      expect(
        document.paths[path ?? '']?.[(method ?? '').toLowerCase()],
        `${method} ${path}`,
      ).toBeDefined()
    }
    for (const suffix of ['', '/resend']) {
      expect(
        document.paths[`/api/v1/public/teams/{handle}/{slug}/waitlist${suffix}`]?.post,
      ).toBeDefined()
    }
  })

  it('maps every documented MCP tool to its real CLI command and validates settings input', () => {
    const tools = waitlistTools({ db: {} as Db })
    for (const tool of tools) {
      const command = Object.entries(COMMANDS).find(([, name]) => name === tool.name)?.[0]
      expect(command).toBeDefined()
      expect(guide).toContain(`| \`${tool.name}\` | \`${command}\` |`)
    }
    const input = JSON.parse(guide.match(/```json\n({ "id":[\s\S]*?)\n```/)?.[1] ?? '')
    const schema = tools.find((tool) => tool.name === 'set_event_type_waitlist')?.input
    expect(schema?.safeParse(input).success).toBe(true)
    expect(schema?.safeParse({ ...input, enabled: 'yes' }).success).toBe(false)
  })

  it('executes the CLI example with the real parser and fake transport', async () => {
    const example = guide.match(/npm run --silent cli -- (.+) <<'JSON'\n(.+)\nJSON/)
    expect(example).not.toBeNull()
    const command = example?.[1] ?? ''
    const input = example?.[2] ?? ''
    let calls = 0
    const errors: string[] = []
    const status = await runCli({
      argv: command.split(/\s+/),
      env: { HOURMERE_URL: 'https://hourmere.example.com', HOURMERE_API_KEY: 'hm_synthetic_docs' },
      stdin: (async function* () {
        yield input
      })(),
      stdout: () => {},
      stderr: (text) => errors.push(text),
      fetch: async (_url, init) => {
        calls++
        const request = JSON.parse(String(init?.body))
        expect(request.params.name).toBe('set_event_type_waitlist')
        expect(request.params.arguments).toEqual(JSON.parse(input))
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          result: { structuredContent: { enabled: true }, content: [] },
        })
      },
    })
    expect(errors).toEqual([])
    expect(status).toBe(0)
    expect(calls).toBe(1)
  })
})
