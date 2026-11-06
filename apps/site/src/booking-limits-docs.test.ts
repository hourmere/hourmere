import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_TYPE_RULE_BOUNDS, validateEventTypeRules } from '@hourmere/core'
import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { COMMANDS, HELP } from '../../../tools/cli/src/cli.ts'
import { eventTypeTools } from '../../server/src/mcp/event-types.ts'
import { EventTypeInput, EventTypeUpdate } from '../../server/src/routes/event-types.ts'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const siteDocs = 'apps/site/src/content/docs/docs'
const prose = (source: string) => source.replace(/[*`]/g, '').replace(/\s+/g, ' ')
const guide = () => prose(read(`${siteDocs}/booking-limits.md`))
const fields = ['maxBookingsPerDay', 'maxBookingsPerWeek', 'maxBookingsPerMonth'] as const
const facts = [
  'day ≤ week, week ≤ month, and day ≤ month whenever both values in a pair are set',
  'The day/month rule also applies when the weekly limit is blank',
  "The host's effective availability schedule supplies the IANA time zone",
  'the selected schedule for that host, or their default schedule where applicable',
  'An ISO week starts on Monday and ends before the following Monday',
  "start instant's local date",
  'Only non-cancelled bookings of this event type assigned to the evaluated host count',
  'All offered meeting lengths share the same allowances',
  "Other event types can block overlapping time but do not consume this event type's allowance",
  'does not cancel or change existing bookings',
  '400 invalid_request',
  '400 invalid_event_type',
]
function assertGuide(source: string) {
  for (const field of fields) {
    const { min, max } = EVENT_TYPE_RULE_BOUNDS[field]
    expect(source).toContain(`whole number from ${min} to ${max}`)
  }
  for (const fact of facts) expect(source).toContain(fact)
}

const limitation =
  'apply per event type and actual host, across all meeting lengths. Organization-wide quotas and rolling windows are unavailable. Lowering a limit does not cancel existing bookings.'

describe('booking limit documentation', () => {
  it('pins the guide to the rule bounds, time-zone, counting and error contract', () => {
    assertGuide(guide())
  })

  it.each(fields)(
    'keeps %s bounds and integer validation aligned with the transport and engine',
    (field) => {
      const { min, max } = EVENT_TYPE_RULE_BOUNDS[field]
      for (const schema of [EventTypeInput, EventTypeUpdate]) {
        for (const value of [min, max, null]) {
          expect(
            schema.safeParse({
              slug: 'limits',
              title: 'Limits',
              durationMinutes: 30,
              [field]: value,
            }).success,
          ).toBe(true)
        }
        for (const value of [1.5, '2']) {
          expect(
            schema.safeParse({
              slug: 'limits',
              title: 'Limits',
              durationMinutes: 30,
              [field]: value,
            }).success,
          ).toBe(false)
        }
      }
      for (const value of [min - 1, max + 1]) {
        expect(() => validateEventTypeRules({ durationMinutes: 30, [field]: value })).toThrow()
      }
    },
  )

  it.each([
    ['maxBookingsPerDay', 'maxBookingsPerWeek'],
    ['maxBookingsPerWeek', 'maxBookingsPerMonth'],
    ['maxBookingsPerDay', 'maxBookingsPerMonth'],
  ] as const)(
    'pins the documented %s ≤ %s pair even with the third ceiling unset',
    (shorter, longer) => {
      expect(() =>
        validateEventTypeRules({ durationMinutes: 30, [shorter]: 2, [longer]: 1 }),
      ).toThrow(`${longer} must be at least`)
      expect(() =>
        validateEventTypeRules({ durationMinutes: 30, [shorter]: 1, [longer]: 2 }),
      ).not.toThrow()
    },
  )

  it('keeps live MCP descriptions aligned with the guide', () => {
    // Registration reads no database and invokes no write handlers.
    for (const tool of eventTypeTools({ db: {} as Db })) {
      expect(['create_event_type', 'update_event_type']).toContain(tool.name)
      for (const field of fields) expect(tool.description).toContain(field)
      const { min, max } = EVENT_TYPE_RULE_BOUNDS.maxBookingsPerWeek
      for (const fact of [
        `accept ${min}–${max} or null for unlimited`,
        'Set ceilings must not descend as periods get longer, even when week is unset',
        'Counts use each host schedule’s local day, ISO week starting Monday, or calendar month',
        'Lowering a ceiling never cancels bookings',
      ])
        expect(tool.description).toContain(fact)
    }
  })

  it('names the live commands, input flag, tools and fields on their own pages', () => {
    const cli = prose(read(`${siteDocs}/cli.md`).split('## Configure booking limits')[1] ?? '')
    const mcp = prose(read(`${siteDocs}/mcp.md`).split('## Configure booking limits')[1] ?? '')
    for (const command of ['create-event', 'update-event', 'event'] as const) {
      expect(cli).toContain(`hourmere ${command} --input`)
      expect(mcp).toContain(COMMANDS[command])
    }
    expect(HELP).toContain('--input FILE|-')
    expect(cli).toContain('--input -')
    for (const field of fields) {
      expect(cli).toContain(field)
      expect(mcp).toContain(field)
    }
  })

  it('mirrors limitations in all three indexes and advertises every editing surface', () => {
    for (const path of ['README.md', 'CHANGELOG.md', `${siteDocs}/index.md`]) {
      const source = read(path)
      expect(prose(source.split('Known limitations')[1] ?? '')).toContain(limitation)
      expect(source).toMatch(/\[Booking limits\]\([^)]*booking-limits[^)]*\)/)
    }
    expect(prose(read('CHANGELOG.md'))).toContain(
      'Hosts can set daily, weekly and monthly booking limits per event type in the editor, REST, MCP and CLI',
    )
    const list =
      read(`${siteDocs}/index.md`).split('## Known limitations')[1]?.split('\n## ')[0]?.trim() ?? ''
    expect(list).not.toMatch(/\n\n-/)
    const explanations = prose(read('docs/availability-explanations.md'))
    expect(explanations).toContain('host-local ISO week (Monday through Sunday)')
    expect(explanations).toContain('host-local calendar month')
  })

  it.each(['whole number from 1 to 1000', ...facts])(
    'rejects a source copy with a changed booking fact: %s',
    (fact) => {
      const source = guide()
      expect(source).toContain(fact)
      expect(() => assertGuide(source.replaceAll(fact, 'incorrect replacement'))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    },
  )
})
