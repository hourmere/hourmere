import { readFileSync } from 'node:fs'
import { z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import { MAX_OPEN_TIME_SNIPPET_RANGE_DAYS } from '../../../packages/scheduling/src/open-time-snippets.ts'
import { GenerateOpenTimeSnippet } from '../../server/src/routes/open-time-snippets.ts'

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
const service = read('packages/scheduling/src/open-time-snippets.ts')
const route = read('apps/server/src/routes/open-time-snippets.ts')
const prose = (source: string) => source.replace(/[*`]/g, '').replace(/\s+/g, ' ')
const assertion = expect.objectContaining({ name: 'AssertionError' })
const count = GenerateOpenTimeSnippet.shape.count.unwrap()
const defaults = Number(service.match(/const count = input.count \?\? (\d+)/)?.[1])
const facts = {
  days: MAX_OPEN_TIME_SNIPPET_RANGE_DAYS,
  min: count.minValue,
  max: count.maxValue,
  defaults,
}
function check(source: string, values = facts) {
  const text = prose(source)
  expect(text).toContain(`${values.days} elapsed days`)
  expect(text).toMatch(
    new RegExp(`(?:${values.min}–${values.max}|from ${values.min} to ${values.max})(?!\\d)`),
  )
  expect(text).toMatch(new RegExp(`default(?:s to)? ${values.defaults}(?!\\d)`))
}

describe('open-time snippet documentation facts', () => {
  it.each(['open-time-snippets', 'rest', 'mcp', 'cli'])(
    '%s matches the service range and request count bounds/default',
    (name) => {
      const source = read(`apps/site/src/content/docs/docs/${name}.md`)
      check(source)
      for (const [before, after] of [
        ['31 elapsed days', '32 elapsed days'],
        ['1–10', '1–11'],
        ['from 1 to 10', 'from 1 to 11'],
        ['default 3', 'default 4'],
        ['defaults to 3', 'defaults to 4'],
      ] as const) {
        // Digit boundary: other limits on the same page (e.g. "from 1 to 1000") must not count.
        const exact = new RegExp(`${before}(?!\\d)`, 'g')
        if (prose(source).match(exact))
          expect(() => check(prose(source).replace(exact, after))).toThrow(assertion)
      }
    },
  )

  it('rejects changed source copies of range, count bounds and default', () => {
    const guide = read('apps/site/src/content/docs/docs/open-time-snippets.md')
    const changedService = service.replace(
      'MAX_OPEN_TIME_SNIPPET_RANGE_DAYS = 31',
      'MAX_OPEN_TIME_SNIPPET_RANGE_DAYS = 32',
    )
    const days = Number(changedService.match(/MAX_OPEN_TIME_SNIPPET_RANGE_DAYS = (\d+)/)?.[1])
    expect(() => check(guide, { ...facts, days })).toThrow(assertion)
    const countExpression = route.match(/count: (z\.number\(\).*?),\n/)?.[1]
    expect(countExpression).toBeDefined()
    for (const [before, after] of [
      ['min(1)', 'min(2)'],
      ['max(10)', 'max(11)'],
    ] as const) {
      const schema = new Function('z', `return ${countExpression?.replace(before, after)}`)(
        z,
      ).unwrap()
      expect(() => check(guide, { ...facts, min: schema.minValue, max: schema.maxValue })).toThrow(
        assertion,
      )
    }
    const changedDefault = service.replace('input.count ?? 3', 'input.count ?? 4')
    expect(() =>
      check(guide, {
        ...facts,
        defaults: Number(changedDefault.match(/const count = input.count \?\? (\d+)/)?.[1]),
      }),
    ).toThrow(assertion)
  })

  it('documents calendar sync recovery separately from an empty result', () => {
    const source = read('apps/site/src/content/docs/docs/open-time-snippets.md')
    const checkRecovery = (text: string) => {
      expect(prose(text)).toContain('409 calendar_sync_unavailable')
      expect(prose(text)).toContain(
        'Retry shortly; this error does not mean there are no available times.',
      )
    }
    checkRecovery(source)
    expect(() =>
      checkRecovery(source.replace('calendar_sync_unavailable', 'no_available_slots')),
    ).toThrow(assertion)
    expect(route).toContain("409: 'no_available_slots, calendar_sync_unavailable'")
  })
})
