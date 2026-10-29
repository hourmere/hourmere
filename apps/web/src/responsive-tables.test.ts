import { describe, expect, it } from 'vitest'
import styles from './styles.css?raw'

function rule(source: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^{}]*)\\}`))
  expect(match, `missing rule: ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

// jsdom has no container-query layout engine; inspect each real query's complete body.
function container(condition: string) {
  const start = styles.indexOf(`@container data-table ${condition} {`)
  expect(start, `missing container query: ${condition}`).toBeGreaterThanOrEqual(0)
  let depth = 1
  const bodyStart = styles.indexOf('{', start) + 1
  let end = bodyStart
  for (; end < styles.length && depth; end++) {
    if (styles[end] === '{') depth++
    if (styles[end] === '}') depth--
  }
  return styles.slice(bodyStart, end - 1)
}

describe('responsive table CSS contract', () => {
  it('breaks long user content anywhere, but only in cells that opt in', () => {
    expect(rule(styles, '.user-content')).toContain('overflow-wrap: anywhere;')
    expect(rule(styles, '.user-content')).toContain('min-width: 0;')
    // Dates, numbers and headers must never split mid-word: no blanket rule on cells.
    expect(rule(styles, '.table th,\n.table td')).not.toContain('overflow-wrap')
    expect(rule(styles, '.table thead th')).not.toContain('overflow-wrap')
    expect(rule(styles, '.table-value')).toContain('min-width: 0;')
  })

  it.each(['.button', '.badge', '.nowrap', '.table .actions'])(
    'keeps short %s labels together',
    (selector) => {
      expect(rule(styles, selector)).toContain('white-space: nowrap;')
    },
  )

  it('sizes columns by content, shrinking short and action columns to fit', () => {
    expect(rule(styles, '.table-container')).toContain('container: data-table / inline-size;')
    expect(rule(styles, '.table-container')).toContain('min-width: 0;')
    expect(rule(styles, '.table')).toContain('table-layout: auto;')
    expect(rule(styles, '.table')).toContain('width: 100%;')
    expect(rule(styles, '.table .fit')).toContain('width: 1%;')
    expect(rule(styles, '.table .actions')).toContain('width: 1%;')
    // The revoke confirmation inside an action cell still wraps its sentence.
    expect(rule(styles, '.table .confirm')).toContain('white-space: normal;')
    // User-content columns share the remaining width in fixed proportions.
    for (const [selector, width] of [
      ['.table-bookings thead th:nth-child(2)', '45%'],
      ['.table-bookings thead th:nth-child(3)', '26%'],
      ['.table-event-types thead th:nth-child(1)', '26%'],
      ['.table-event-types thead th:nth-child(3)', '24%'],
      ['.table-api-keys thead th:nth-child(1)', '24%'],
      ['.table-api-keys thead th:nth-child(3)', '16%'],
    ]) {
      expect(rule(styles, selector ?? '')).toContain(`width: ${width};`)
    }
    // No column of a short kind is given a fixed width that could squeeze a date.
    expect(styles).not.toMatch(
      /\.table-[a-z-]+ thead th:nth-child\(\d\) \{\n {2}width: \d+(\.\d+)?rem;/,
    )
  })

  it('lets the activity table keep its padding budget between 400 and 480px', () => {
    const compact = container('(min-width: 400px) and (not (min-width: 480px))')
    expect(rule(compact, '.table-analytics th,\n  .table-analytics td')).toContain(
      'padding-inline: var(--space-2);',
    )
  })

  it.each([
    ['not (min-width: 400px)', '.table'],
    [
      '(min-width: 400px) and (not (min-width: 880px))',
      ':is(.table-bookings, .table-api-keys, .table-event-types)',
    ],
  ])('uses aligned title-first cards when %s', (condition, selector) => {
    const card = container(condition)
    expect(rule(card, `${selector} tbody tr`)).toContain('display: flex;')
    expect(rule(card, `${selector} tbody tr`)).toContain('flex-direction: column;')
    expect(rule(card, `${selector} th[scope="row"]`)).toContain('order: -1;')
    expect(rule(card, `${selector} td[data-label]`)).toContain('display: grid;')
    expect(rule(card, `${selector} td[data-label]`)).toContain(
      'grid-template-columns: 6.5rem minmax(0, 1fr);',
    )
    expect(rule(card, `${selector} td[data-label]::before`)).toContain('content: attr(data-label);')
    // A one-line value's label still wraps between words, and fit columns fill the card.
    expect(rule(card, `${selector} td[data-label]::before`)).toContain('white-space: normal;')
    expect(rule(card, `${selector} :is(.fit, .actions)`)).toContain('width: auto;')
    expect(rule(card, `${selector} .badge`)).toContain('margin: 0;')
    expect(rule(card, `${selector} .confirm`)).toContain('min-width: 0;')
    expect(rule(card, `${selector} .confirm`)).toContain('max-width: 100%;')
    // A card's date and time range wrap as whole units, never inside one of them.
    expect(card).not.toMatch(/time \.nowrap \{[^}]*white-space: normal;/)
    expect(rule(card, `${selector} thead`)).toContain('clip-path: inset(50%);')
    expect(rule(card, `${selector} thead th`)).toContain('overflow: hidden;')
    expect(rule(card, `${selector} thead th`)).toContain('clip-path: inset(50%);')
  })

  it('starts captions at the same edge in table and card modes', () => {
    const base = rule(styles, '.table caption')
    expect(base).toContain('text-align: start;')
    expect(base).toContain('margin-bottom: var(--space-2);')
    const caption = rule(container('not (min-width: 640px)'), '.table caption')
    expect(caption).toContain('display: block;')
    expect(caption).toContain('width: 100%;')
    expect(caption).toContain('text-align: start;')
    expect(caption).toContain('margin-bottom: var(--space-2);')
  })

  it('stacks every narrow booking field and separates complete date/time pieces', () => {
    const narrow = container('not (min-width: 440px)')
    expect(rule(narrow, '.table-bookings :is(th, td)')).toContain('padding-inline: var(--space-2);')
    const field = rule(narrow, '.table-bookings td[data-label]')
    expect(field).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(field).toContain('gap: 0;')
    expect(rule(narrow, '.table-bookings .booking-when time')).toContain(
      'font-size: var(--text-sm);',
    )
    expect(rule(narrow, '.table-bookings .booking-when time .nowrap')).toContain('display: block;')
    expect(rule(styles, '.nowrap')).toContain('white-space: nowrap;')
    // The overrides end before wider cards and tables, leaving table geometry intact.
    expect(styles.split(narrow).join('')).not.toMatch(/\.booking-when[^{}]*\{/)
  })

  it('keeps analytics in table mode from 400px while dense tables still use cards', () => {
    const narrow = container('not (min-width: 400px)')
    const tablet = container('(min-width: 400px) and (not (min-width: 880px))')
    const analytics = document.createElement('table')
    analytics.className = 'table table-analytics'
    const dense = document.createElement('table')
    dense.className = 'table table-bookings'
    // Test the selectors that actually switch tables to block layout in each range.
    const blockSelectors = (source: string) =>
      [...source.matchAll(/([^{}]+)\{\s*display: block;/g)].map((match) => match[1]?.trim() ?? '')
    expect(blockSelectors(narrow).some((selector) => analytics.matches(selector))).toBe(true)
    expect(blockSelectors(tablet).some((selector) => analytics.matches(selector))).toBe(false)
    expect(blockSelectors(tablet).some((selector) => dense.matches(selector))).toBe(true)
    expect(
      blockSelectors(container('not (min-width: 640px)')).some((selector) =>
        analytics.matches(selector),
      ),
    ).toBe(false)
    expect(
      rule(
        container('(min-width: 400px) and (not (min-width: 640px))'),
        '.table-analytics caption',
      ),
    ).toContain('display: table-caption;')
  })
})
