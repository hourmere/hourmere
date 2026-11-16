import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const initial = { id: 'first', noShowMarkedAt: null }
const marked = { ...initial, noShowMarkedAt: '2026-11-01T10:00:00Z' }
const next = { id: 'next', noShowMarkedAt: null }

function negativeControl(
  source: string,
  before: string,
  after: string,
  assertion: (source: string) => void,
) {
  expect(source.split(before)).toHaveLength(2)
  assertion(source)
  expect(() => assertion(source.replace(before, after))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  assertion(source)
}

describe('no-show pagination source-copy controls', () => {
  it('detects replacing host marks with the request-time snapshot', () => {
    const source = readFileSync('apps/web/src/pages/bookings/Bookings.tsx', 'utf8')
    const block = source.match(
      /setMore\(\(current\) => \(\{\n\s*bookings: \[\.\.\.\(current \?\? loaded\)\.bookings,[\s\S]*?\}\)\)/,
    )?.[0]
    if (!block) throw new Error('Missing pagination update')
    negativeControl(block, '(current ?? loaded)', 'loaded', (code) => {
      let updated: { bookings: (typeof marked)[] } | undefined
      new Function('setMore', 'loaded', 'page', code)(
        (update: (state: unknown) => typeof updated) => {
          updated = update({ bookings: [marked] })
        },
        { bookings: [initial] },
        { data: [next], nextCursor: null },
      )
      expect(updated?.bookings).toEqual([marked, next])
    })
  })

  it('detects replacing team marks with the request-time snapshot', () => {
    const source = readFileSync('apps/web/src/pages/team-bookings/TeamBookings.tsx', 'utf8')
    const block = source.match(
      /const data = \[\.\.\.\(loadedSnapshot\.current \?\? shown\)\.data, \.\.\.page\.data\]/,
    )?.[0]
    if (!block) throw new Error('Missing pagination update')
    negativeControl(block, '(loadedSnapshot.current ?? shown)', 'shown', (code) => {
      const data = new Function('loadedSnapshot', 'shown', 'page', `${code}; return data`)(
        { current: { data: [marked] } },
        { data: [initial] },
        { data: [next] },
      )
      expect(data).toEqual([marked, next])
    })
  })
})

it.each([
  ['latest data', 'loadedSnapshot.current ?? shown', 'shown'],
  ['current source', 'latestSource.current ?? source', 'source'],
])('detects using stale team %s for delayed completion', (_, before, after) => {
  const source = readFileSync('apps/web/src/pages/team-bookings/TeamBookings.tsx', 'utf8')
  const start = source.indexOf('  function applyNoShow(')
  const end = source.indexOf('  async function loadMore(', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const block = source.slice(start, end)
  negativeControl(block, before, after, (code) => {
    const old = { data: [initial], nextCursor: 'old' }
    const current = { data: [marked, next], nextCursor: 'current' }
    let result: { data: (typeof marked)[]; source: unknown } | undefined
    // This source copy executes the production updater with a delayed callback's old
    // captured values, after a refresh and another completed row update.
    const javascript = code
      .replace(': string', '')
      .replace(': NoShowChange', '')
      .replace(': boolean', '')
      .replace(': BookingPage', '')
    new Function(
      'loadedSnapshot',
      'shown',
      'latestSource',
      'source',
      'withNoShowChange',
      'setMore',
      'setSelected',
      'setStatus',
      `${javascript}; applyNoShow('next', {}, false)`,
    )(
      { current },
      old,
      { current },
      old,
      (booking: typeof next) => ({ ...booking, noShowMarkedAt: marked.noShowMarkedAt }),
      (value: typeof result) => {
        result = value
      },
      () => {},
      () => {},
    )
    expect(result?.data).toEqual([marked, { ...next, noShowMarkedAt: marked.noShowMarkedAt }])
    expect(result?.source).toBe(current)
  })
})

it('detects reporting an unknown no-show total as zero', () => {
  const source = readFileSync('apps/web/src/pages/Analytics.tsx', 'utf8')
  const expression = source.match(
    /data\.totals\.noShows == null\s*\? '—'\s*: new Intl.NumberFormat\(displayLocale\).format\(data.totals.noShows\)/,
  )?.[0]
  if (!expression) throw new Error('Missing unknown count presentation')
  negativeControl(expression, "'—'", "'0'", (code) => {
    expect(new Function('data', 'displayLocale', `return ${code}`)({ totals: {} }, 'en')).toBe('—')
  })
})
