import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { validateEventTypeRules } from '@hourmere/core'
import { describe, expect, it } from 'vitest'
import { EVENT_TYPE_LIMITS } from './event-types.ts'
import { engineValidation } from './internal.ts'

type Change = readonly [string, string]
const original = readFileSync(new URL('./event-types.ts', import.meta.url), 'utf8')
const identity = (value: unknown) => value
const bindings = {
  validateEventTypeRules,
  engineValidation,
  EVENT_TYPE_LIMITS,
  validSlug: identity,
  validTitle: identity,
  validDescription: identity,
  validLocation: identity,
  validateSuccessRedirect: identity,
  validateQuestions: identity,
  parseQuestions: identity,
  jsonb: identity,
}

function sourceCopy(start: string, end: string, change?: Change) {
  const offset = original.indexOf(start)
  expect(offset).toBeGreaterThan(-1)
  let source = original.slice(offset, original.indexOf(end, offset))
  if (change) {
    expect(source.includes(change[0]), 'mutation must match production source').toBe(true)
    source = source.replace(...change)
  }
  return new Function(
    ...Object.keys(bindings),
    `${stripTypeScriptTypes(source)}; return ${start.match(/function (\w+)/)?.[1]}`,
  )(...Object.values(bindings)) as (input: Record<string, unknown>) => Record<string, unknown>
}

const fields = {
  slug: 'intro',
  title: 'Intro',
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minimumNoticeMinutes: 0,
  maxBookingsPerDay: 2,
  maxBookingsPerWeek: 4,
  maxBookingsPerMonth: 8,
  isActive: true,
  isHidden: false,
  allowGuests: false,
  position: 0,
}

describe('booking limit service source-copy mutations', () => {
  for (const [field, column] of [
    ['maxBookingsPerWeek', 'max_bookings_per_week'],
    ['maxBookingsPerMonth', 'max_bookings_per_month'],
  ] as const) {
    it(`detects omitted ${field} validation with a real assertion failure`, () => {
      const verify = (normalize: ReturnType<typeof sourceCopy>) => {
        expect(() => normalize({ ...fields, [field]: 1001 })).toThrowError()
        expect(() => normalize({ ...fields, [field]: 1 })).toThrowError()
      }
      verify(sourceCopy('function validFields(', 'function validSlug('))
      const mutant = sourceCopy('function validFields(', 'function validSlug(', [
        `${field}: c.${field} ?? undefined,`,
        `${field}: undefined,`,
      ])
      expect(() => verify(mutant)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    })

    it(`detects omitted ${field} normalization with a real assertion failure`, () => {
      const verify = (normalize: ReturnType<typeof sourceCopy>) =>
        expect(normalize(fields)[field]).toBe(fields[field])
      verify(sourceCopy('function validFields(', 'function validSlug('))
      const mutant = sourceCopy('function validFields(', 'function validSlug(', [
        `${field}: (c.${field} ?? null) as number | null,`,
        `${field}: null,`,
      ])
      expect(() => verify(mutant)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    })

    it(`detects omitted ${field} writes with a real assertion failure`, () => {
      const verify = (columns: ReturnType<typeof sourceCopy>) =>
        expect(columns(fields)[column]).toBe(fields[field])
      verify(sourceCopy('function columns(', 'function toEventType('))
      const mutant = sourceCopy('function columns(', 'function toEventType(', [
        `${column}: fields.${field},`,
        `${column}: null,`,
      ])
      expect(() => verify(mutant)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    })

    it(`detects omitted ${field} reads with a real assertion failure`, () => {
      const verify = (project: ReturnType<typeof sourceCopy>) =>
        expect(project({ allowed_durations_minutes: [30], [column]: 7 })[field]).toBe(7)
      verify(sourceCopy('function fieldsOf(', 'function columns('))
      const mutant = sourceCopy('function fieldsOf(', 'function columns(', [
        `${field}: row.${column},`,
        `${field}: null,`,
      ])
      expect(() => verify(mutant)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    })
  }
})
