import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EVENT_TYPE_RULE_BOUNDS,
  MAX_ALLOWED_DURATIONS,
  validateEventTypeRules,
} from '@hourmere/core'
import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { eventTypeTools } from '../../server/src/mcp/event-types.ts'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const siteDocs = 'apps/site/src/content/docs/docs'
const guide = () => read(`${siteDocs}/multiple-durations.md`)
const prose = (source: string) => source.replace(/[*`]/g, '').replace(/\s+/g, ' ')

function assertDurationLimits(source: string) {
  const text = prose(source)
  const { min, max } = EVENT_TYPE_RULE_BOUNDS.durationMinutes
  expect(text).toContain(`${min}–${MAX_ALLOWED_DURATIONS} distinct lengths`)
  expect(text).toContain(`${min}–${max} whole minutes`)
  expect(text).toContain('The default must be one of those lengths.')
}

function assertRescheduleContract(source: string) {
  const text = prose(source).split('## Rescheduling ')[1]?.split('## Current limits')[0] ?? ''
  expect(text).toContain("preserves the booking's original elapsed length")
  expect(text).toContain('removed that length from the event type')
  expect(text).toContain('must belong to the current allowed list')
}

function assertEventTypeToolHints(source: string) {
  const table = source.split('\n## Tools\n')[1]?.split('\n\nConfiguration discovery')[0] ?? ''
  // Defining tools does not access the database or invoke their write handlers.
  for (const tool of eventTypeTools({ db: {} as Db })) {
    const row = table.split('\n').find((line) => line.startsWith(`| \`${tool.name}\` |`))
    const hints = [
      tool.annotations.readOnlyHint && 'read-only',
      tool.annotations.destructiveHint && 'destructive',
      tool.annotations.idempotentHint && 'idempotent',
      tool.annotations.openWorldHint && 'open world',
    ].filter(Boolean)
    expect(row?.split('|')[3]?.trim(), tool.name).toBe(hints.join(', ') || '—')
  }
}

describe('multiple meeting length documentation', () => {
  it('matches event-type tool table hints to the live MCP annotations', () => {
    assertEventTypeToolHints(read(`${siteDocs}/mcp.md`))
  })

  it.each(['create_event_type', 'update_event_type'])(
    'rejects an open-world hint in a source copy of the %s documentation row',
    (name) => {
      const source = read(`${siteDocs}/mcp.md`)
      const table = source.split('\n## Tools\n')[1] ?? ''
      const row = table.split('\n').find((line) => line.startsWith(`| \`${name}\` |`))
      expect(row).toBeDefined()
      const cells = (row ?? '').split('|')
      expect(cells[3]).not.toContain('open world')
      cells[3] = ` ${cells[3]?.trim() === '—' ? '' : `${cells[3]?.trim()}, `}open world `
      expect(() => assertEventTypeToolHints(source.replace(row ?? '', cells.join('|')))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    },
  )

  it('matches the engine bounds and default membership rule', () => {
    assertDurationLimits(guide())
  })

  it('documents editor actions, personal and team support, and saved sharing', () => {
    const text = prose(guide())
    for (const action of [
      'personal or team space',
      'Allowed durations',
      '15, 30, 45, 60 or 90-minute presets',
      'Duration to add (minutes)',
      'Add duration',
      'Default duration',
      'at least one must remain',
      'Removing the current default selects the first remaining length',
      'View and share',
      'first-run setup guide',
    ]) {
      expect(text).toContain(action)
    }
  })

  it('explains invitee choice, refreshed availability and booking history', () => {
    const text = prose(guide())
    expect(text).toContain('Personal, team and embedded booking pages')
    expect(text).toContain('with the default selected')
    expect(text).toContain('Choosing another length refreshes the available times')
    expect(text).toContain('preserving their entered details, guests and answers')
    expect(text).toContain("does not change an existing booking's length")
  })

  it('preserves original reschedule lengths and limits explicit changes', () => {
    assertRescheduleContract(guide())
  })

  it('keeps create and update examples valid under the shared service rules', () => {
    const examples = [...guide().matchAll(/```json\n([\s\S]*?)\n```/g)]
    expect(examples).toHaveLength(2)
    for (const [, source] of examples) {
      const input = JSON.parse(source ?? '')
      expect(() => validateEventTypeRules(input)).not.toThrow()
      expect(input.allowedDurationsMinutes).toContain(input.durationMinutes)
    }
  })

  it('explains write interfaces, compatibility and full key scope across the guides', () => {
    for (const path of [`${siteDocs}/multiple-durations.md`, `${siteDocs}/mcp.md`, 'docs/mcp.md']) {
      const text = prose(read(path))
      for (const name of ['create_event_type', 'update_event_type', 'allowedDurationsMinutes']) {
        expect(text, path).toContain(name)
      }
      expect(text, path).toContain('full')
    }
    for (const path of [`${siteDocs}/cli.md`, 'tools/cli/README.md']) {
      const text = prose(read(path))
      for (const name of ['create-event', 'update-event', 'allowedDurationsMinutes']) {
        expect(text, path).toContain(name)
      }
      expect(text, path).toContain('full')
    }
    const text = prose(guide())
    expect(text).toContain('omitting allowedDurationsMinutes creates the single-length list')
    expect(text).toContain('changing only the default on a single-length type also replaces')
    expect(text).toContain('the new default must already belong to the saved list')
    expect(text).toContain('bookings and read keys cannot change event types')
  })

  it('rejects changed source copies of every documented duration protection', () => {
    for (const [before, after] of [
      ['1–12 distinct lengths', '1–13 distinct lengths'],
      ['1–1440 whole minutes', '1–1441 whole minutes'],
      ['The default must\nbe one of those lengths.', 'Any default is accepted.'],
    ] as const) {
      const source = guide()
      expect(source).toContain(before)
      expect(() => assertDurationLimits(source.replace(before, after))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    }
    for (const [before, after] of [
      ["preserves the booking's original elapsed length", 'uses the current default'],
      ['removed that length from the event type', 'kept that length in the event type'],
      ['must belong to the current allowed list', 'can use any positive length'],
    ] as const) {
      const source = guide()
      expect(source).toContain(before)
      expect(() => assertRescheduleContract(source.replace(before, after))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    }
  })
})
