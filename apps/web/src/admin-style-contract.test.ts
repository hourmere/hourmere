import { describe, expect, it } from 'vitest'
import styles from './styles.css?raw'

function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = styles.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^{}]*)\\}`))?.[1]
  expect(body, `missing ${selector}`).toBeDefined()
  return body ?? ''
}

describe('admin polish CSS protections', () => {
  it('shrinks nested grid stacks and wraps long empty-state actions inside their panel', () => {
    expect(rule('.stack')).toContain('min-width: 0;')
    expect(rule('.stack')).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(rule('.empty-actions > .button')).toContain('max-width: 100%;')
    expect(rule('.empty-actions > .button')).toContain('white-space: normal;')
  })

  it('gives editor checkboxes a 24px target even beside interactive field hints', () => {
    const controls = rule('.editor input:is([type="checkbox"], [type="radio"])')
    expect(controls).toContain('width: 1.5rem;')
    expect(controls).toContain('height: 1.5rem;')
  })

  it('uses one six-step type scale throughout the shared stylesheet', () => {
    const tokens = rule(':root')
    for (const [name, size] of [
      ['xs', '0.8125rem'],
      ['sm', '0.875rem'],
      ['md', '1rem'],
      ['lg', '1.125rem'],
      ['xl', '1.5rem'],
      ['2xl', '1.75rem'],
    ]) {
      expect(tokens).toContain(`--text-${name}: ${size};`)
    }
    const sizes = [...styles.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1])
    expect(sizes.length).toBeGreaterThan(20)
    expect(
      sizes.every((size) =>
        /^var\(--text-(xs|sm|md|lg|xl|2xl)\)$|^max\(16px, var\(--text-md\)\)$/.test(size ?? ''),
      ),
    ).toBe(true)
  })

  it('stacks analytics dates until each native control has room for a full date', () => {
    expect(rule('.analytics-filters')).toContain('container: analytics-filters / inline-size;')
    expect(rule('.analytics-date-range')).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(rule('.analytics-date-range')).toContain('align-items: end;')
    expect(rule('.analytics-date-range')).toContain('gap: var(--space-4);')
    expect(styles).toMatch(
      /@container analytics-filters \(min-width: 400px\)\s*\{\s*\.analytics-date-range\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    )
  })

  it('separates analytics metrics and spaces the caption', () => {
    expect(rule('.metric-cards')).toContain('display: grid;')
    expect(rule('.metric-cards > div')).toContain('padding: var(--space-4);')
    expect(rule('.metric-cards dd')).toContain('font-size: var(--text-2xl);')
    expect(rule('.table .analytics-caption')).toContain(
      'padding-block: var(--space-3) var(--space-2);',
    )
  })

  it('styles success notices and distinguishes neutral badges in dark mode', () => {
    expect(rule('.alert-success')).toContain('border-color: var(--success-border);')
    expect(rule('.alert-success')).toContain('background: var(--success-soft);')
    expect(rule('.badge')).toContain('border: 1px solid var(--border-strong);')
    expect(rule('.event-type-inactive th[scope="row"] a')).toContain('color: var(--muted);')
    expect(rule('.event-type-inactive')).toContain('background: var(--bg);')
  })

  it('keeps commands on scrollable lines and booking paths truncated beside copying', () => {
    expect(rule('.code-block')).toContain('min-width: 0;')
    const pre = rule('.code-block pre')
    for (const declaration of [
      'overflow-x: auto;',
      'white-space: pre;',
      'word-break: normal;',
      'overflow-wrap: normal;',
    ])
      expect(pre).toContain(declaration)
    const focus = rule('.code-block pre:focus-visible')
    expect(focus).toContain('outline: 3px solid var(--focus);')
    expect(focus).toContain('outline-offset: 2px;')
    expect(rule('.booking-link a,\n.booking-link .preview')).toContain('text-overflow: ellipsis;')
    expect(rule('.booking-link a,\n.booking-link .preview')).toContain('white-space: nowrap;')
    expect(rule('.booking-link a,\n.booking-link .preview')).toContain('min-width: 0;')
  })

  it('wraps visible date and time as complete units', () => {
    expect(rule('.date-time')).toContain('flex-wrap: wrap;')
    expect(rule('.date-time > span')).toContain('white-space: nowrap;')
  })

  it('uses separate table borders so the outer radius can render', () => {
    expect(rule('.table')).toContain('border-collapse: separate;')
    expect(rule('.table')).toContain('border-spacing: 0;')
    expect(rule('.table')).toContain('border-radius: var(--radius);')
  })

  it('uses compatible container conditions and gives the smallest cards more value space', () => {
    const queries = [...styles.matchAll(/@container[^{]+/g)].map((match) => match[0])
    expect(queries.length).toBeGreaterThan(5)
    for (const query of queries) expect(query).not.toMatch(/\bwidth\s*[<>=]|[<>=]\s*width\b/)
    expect(styles).toMatch(
      /@container data-table \(max-width: 300px\)\s*\{\s*\.table td\[data-label\] \{\s*grid-template-columns: 5rem minmax\(0, 1fr\);/,
    )
  })

  it('keeps sticky saving in flow and disables it in short windows', () => {
    expect(rule('html')).toContain(
      'scroll-padding-bottom: calc(var(--sticky-actions-height, 0px) + var(--space-3));',
    )
    expect(rule('.sticky-form-actions')).toContain('position: sticky;')
    expect(rule('.sticky-form-actions')).toContain('bottom: 0;')
    expect(rule('.sticky-form-actions')).toContain('background: var(--surface);')
    expect(styles).toMatch(
      /@media \(max-height: 500px\)\s*\{\s*\.sticky-form-actions \{\s*position: static;/,
    )
    expect(rule('html')).toContain(
      'scroll-padding-top: calc(var(--topbar-height) + 1px + var(--space-2));',
    )
  })

  it('keeps a time range together in three grid columns and options beside labeled icon buttons', () => {
    expect(rule('.interval-row')).toContain(
      'grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);',
    )
    expect(rule('.interval-row > .button')).toContain('grid-column: 3;')
    expect(rule('.time-input')).toContain('min-width: 0;')
    expect(rule('.time-input')).toContain('padding-inline: var(--space-1);')
    expect(rule('.option-row')).toContain('flex-wrap: nowrap;')
    expect(rule('.option-row input')).toContain('flex: 1 1 0;')
    expect(rule('.question-card')).toContain('padding: var(--space-2);')
    expect(rule('.options')).toContain('padding-left: var(--space-2);')
    expect(rule('.button-icon')).toContain('flex: none;')
  })

  it('keeps Chinese introductions readable and 320px card language controls inside the header', () => {
    expect(rule('.lede')).toContain('max-width: 65ch;')
    expect(rule('.lede:lang(zh)')).toContain('max-width: 40em;')
    expect(rule('.card-header .logo-word')).toContain('display: none;')
    expect(rule('.card-header .language-picker')).toContain('max-width: 100%;')
    expect(rule('.card-header .language-picker select')).toContain('min-width: 0;')
  })

  it('extends coarse pointer targets to normal buttons, fields, navigation and the logo', () => {
    const coarse = styles.slice(styles.indexOf('@media (pointer: coarse)'))
    const controls = coarse.slice(0, coarse.indexOf('  .breadcrumb'))
    for (const selector of [
      '.button,',
      '.button-small,',
      'input:not([type="checkbox"]):not([type="radio"]),',
      'select,',
      '.sidenav a,',
      '.tabs a,',
      '.topbar .brand,',
    ])
      expect(controls).toContain(selector)
    expect(controls).toContain('min-height: 44px;')
    expect(controls).toContain('min-width: 44px;')
    expect(rule('input.mono,\nselect.mono,\ntextarea.mono')).toContain(
      'font-size: max(16px, var(--text-md));',
    )
  })
})
