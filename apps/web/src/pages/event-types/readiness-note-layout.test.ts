import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('apps/web/src/styles.css', 'utf8')

function expectCardCaption(source: string) {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(source)
  const cardRule = [...sheet.cssRules].find(
    (rule) => 'conditionText' in rule && rule.conditionText === 'data-table not (min-width: 880px)',
  ) as CSSConditionRule | undefined
  expect(cardRule, 'caption uses the same exclusive 880px breakpoint as card tables').toBeDefined()
  const caption = [...(cardRule?.cssRules ?? [])].find(
    (rule) =>
      'selectorText' in rule &&
      rule.selectorText === ':is(.table-bookings, .table-api-keys, .table-event-types) caption',
  ) as CSSStyleRule | undefined
  expect(caption, 'all card tables share the full-width caption rule').toBeDefined()
  // Native table-caption sizing creates an anonymous narrow table in card mode.
  // The old generic <640px rule left the 640–879px container range uncovered.
  expect(caption?.style.display).toBe('block')
  expect(caption?.style.width).toBe('100%')
}

describe('readiness note card layout', () => {
  it('uses the full card table width throughout the card breakpoint', () => {
    expectCardCaption(styles)
  })

  it.each([
    {
      name: 'the old 640px breakpoint gap',
      before: '@container data-table not (min-width: 880px)',
      after: '@container data-table not (min-width: 640px)',
    },
    { name: 'native caption sizing', before: 'display: block;', after: 'display: table-caption;' },
    { name: 'a narrow caption width', before: 'width: 100%;', after: 'width: 1%;' },
    {
      name: 'omitted shared card tables',
      before: ':is(.table-bookings, .table-api-keys, .table-event-types) caption',
      after: '.table-event-types caption',
    },
  ])('detects $name in a stylesheet source copy', ({ before, after }) => {
    const start = styles.indexOf('@container data-table not (min-width: 880px)')
    const end = styles.indexOf('\n}', start) + 2
    const block = styles.slice(start, end)
    expect(block.split(before)).toHaveLength(2)
    const mutant = styles.slice(0, start) + block.replace(before, after) + styles.slice(end)
    expect(() => expectCardCaption(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    expectCardCaption(styles)
  })
})
