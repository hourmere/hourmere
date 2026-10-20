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
  const start = styles.indexOf(`@container data-table (${condition}) {`)
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
  it('keeps unbroken user content within its available width', () => {
    expect(rule(styles, '.user-content')).toContain('overflow-wrap: anywhere;')
    expect(rule(styles, '.user-content')).toContain('min-width: 0;')
    expect(rule(styles, '.table th,\n.table td')).toContain('overflow-wrap: anywhere;')
    expect(rule(styles, '.table-value')).toContain('min-width: 0;')
  })

  it.each(['.button', '.badge', '.nowrap'])('keeps short CJK %s labels together', (selector) => {
    expect(rule(styles, selector)).toContain('white-space: nowrap;')
  })

  it('sizes tables to their wrapper with fixed columns', () => {
    expect(rule(styles, '.table-container')).toContain('container: data-table / inline-size;')
    expect(rule(styles, '.table-container')).toContain('min-width: 0;')
    expect(rule(styles, '.table')).toContain('table-layout: fixed;')
    expect(rule(styles, '.table')).toContain('width: 100%;')
    for (const [selector, width] of [
      ['.table-bookings thead th:nth-child(1)', '12.5rem'],
      ['.table-bookings thead th:nth-child(3)', '26%'],
      ['.table-bookings thead th:nth-child(4)', '12rem'],
      ['.table-event-types thead th:nth-child(1)', '26%'],
      ['.table-event-types thead th:nth-child(2)', '9rem'],
      ['.table-event-types thead th:nth-child(4)', '10.5rem'],
      ['.table-event-types thead th:nth-child(5)', '5.5rem'],
      ['.table-api-keys thead th:nth-child(1),\n.table-api-keys thead th:nth-child(3)', '16%'],
      ['.table-api-keys thead th:nth-child(7)', '15rem'],
    ]) {
      expect(rule(styles, selector ?? '')).toContain(`width: ${width};`)
    }
  })

  it.each([
    ['width < 640px', '.table'],
    ['640px <= width < 880px', ':is(.table-bookings, .table-api-keys, .table-event-types)'],
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
    expect(rule(card, `${selector} .badge`)).toContain('margin: 0;')
    expect(rule(card, `${selector} .confirm`)).toContain('min-width: 0;')
    expect(rule(card, `${selector} .confirm`)).toContain('max-width: 100%;')
    expect(rule(card, `${selector} time .nowrap`)).toContain('white-space: normal;')
    expect(rule(card, `${selector} thead`)).toContain('clip-path: inset(50%);')
  })
})
