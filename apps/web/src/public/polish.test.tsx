import { readFileSync } from 'node:fs'
import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fakeApi, json, renderApp } from '../test/fake-api.tsx'
import { EVENT } from '../test/public-fixtures.ts'

const css = readFileSync('apps/web/src/public/public.css', 'utf8')
const styles = readFileSync('apps/web/src/styles.css', 'utf8')

function rules(source: string) {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(source.replace(/^@import[^;]+;/m, ''))
  const found: CSSStyleRule[] = []
  function visit(list: CSSRuleList) {
    for (const rule of list) {
      if ('selectorText' in rule) found.push(rule as CSSStyleRule)
      if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules)
    }
  }
  visit(sheet.cssRules)
  return found
}
const parsed = [...rules(css), ...rules(styles)]
function rule(selector: string, parent?: string) {
  const found = parsed.findLast(
    (r) =>
      r.selectorText.split(',').some((part) => part.trim() === selector) &&
      (parent
        ? (r.parentRule as CSSConditionRule | null)?.conditionText === parent
        : !r.parentRule),
  )
  expect(found, `${selector} (${parent ?? 'base'})`).toBeDefined()
  return found?.style as CSSStyleDeclaration
}

describe('public booking polish CSS', () => {
  it('aligns narrow event and picker edges and shares the container-driven wide layout', () => {
    expect(rule('.public .event-info').padding).toBe('var(--space-5) var(--space-4) 0')
    expect(rule('.public .booking-main').padding).toBe('0 var(--space-4) var(--space-5)')
    expect(rule('.public .public-main').getPropertyValue('container')).toBe(
      'public-page / inline-size',
    )
    expect(
      rule('.public .booking-layout', 'public-page (min-width: 900px)').gridTemplateColumns,
    ).toBe('300px minmax(0, 1fr)')
  })

  it('clamps event descriptions below 900px and host cards to three preserved lines', () => {
    for (const selector of [
      '.public .event-description-collapsed',
      '.public .event-card-description',
    ]) {
      expect(rule(selector).getPropertyValue('-webkit-line-clamp')).toBe('3')
      expect(rule(selector).overflow).toBe('hidden')
    }
    expect(rule('.public .event-card-description').whiteSpace).toBe('pre-line')
    expect(
      rule('.public .event-description-collapsed', 'public-page (min-width: 900px)').display,
    ).toBe('block')
    expect(rule('.public .description-toggle', 'public-page (min-width: 900px)').display).toBe(
      'none',
    )
  })

  it('keeps offsets unbroken and removes the second manage-link panel padding', () => {
    expect(rule('.public .time-offset').whiteSpace).toBe('nowrap')
    expect(rule('.public .manage-link').padding).toBe('0px')
    expect(rule('.public .manage-link').border).toBe('0px')
  })

  it('uses compact guest rows and separated checkbox targets on touch screens', () => {
    expect(rule('.public .guest').gridTemplateColumns).toBe('minmax(0, 1fr) minmax(0, 1fr)')
    expect(rule('.public .guest').padding).toBe('var(--space-2)')
    expect(rule('.public .guest-remove').gridColumn).toBe('1 / -1')
    // An error under one input must neither stretch nor push down the row's other input.
    expect(rule('.public .guest .field').alignContent).toBe('start')
    const wide = 'public-page (min-width: 480px)'
    expect(rule('.public .guest', wide).alignItems).toBe('start')
    expect(rule('.public .guest-remove', wide).alignSelf).toBe('start')
    expect(rule('.public .guest-remove', wide).marginTop).toBe(
      'calc(0.875rem * 1.55 + var(--space-1))',
    )
    expect(rule('.public .booking-form .choices').gap).toBe('var(--space-2)')
    expect(styles).toMatch(/--space-2:\s*8px/)
    expect(rule('.public .choice', '(pointer: coarse)').minHeight).toBe('44px')
  })

  it('prints light readable booking details and hides every private management capability', () => {
    const print = rule('.public', 'print')
    expect(print.getPropertyValue('--surface')).toBe('#ffffff')
    expect(print.getPropertyValue('--text')).toBe('#0e1015')
    expect(print.getPropertyValue('--danger-soft')).toBe('#fef0ee')
    expect(print.getPropertyValue('--error-text')).toBe('#b42318')
    expect(print.getPropertyValue('color-scheme')).toBe('light')
    for (const selector of [
      '.public .public-language',
      '.public .public-footer',
      '.public button',
      '.public .button',
      '.public .manage-link',
      '.public a[href*="#token="]',
      '.public .add-to-calendar',
      '.public .public-signup',
    ]) {
      const hide = rule(selector, 'print')
      expect(hide.display, selector).toBe('none')
      expect(hide.getPropertyPriority('display')).toBe('important')
    }
    expect(rule('.public .public-card', 'print').boxShadow).toBe('none')
  })

  it('preserves active public navigation state in Windows high contrast', () => {
    expect(rule('.sidenav a[aria-current="page"]', '(forced-colors: active)').outline).toBe(
      '2px solid Highlight',
    )
    expect(rule('.sidenav a[aria-current="page"]', '(forced-colors: active)').textDecoration).toBe(
      'underline',
    )
  })

  it('uses the contrast-safe danger role for public danger panel borders in both themes', () => {
    expect(rule('.panel-danger').borderColor).toBe('var(--danger)')
    // Resolve the actual shared role values; do not silently substitute a test-only colour.
    const tokenRules = rules(styles).filter((r) => r.selectorText === ':root')
    expect(tokenRules).toHaveLength(2)
    const luminance = (hex: string) => {
      const channels =
        hex
          .slice(1)
          .match(/../g)
          ?.map((c) => Number.parseInt(c, 16) / 255) ?? []
      return channels
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0)
    }
    for (const tokens of tokenRules) {
      const foreground = luminance(tokens.style.getPropertyValue('--danger').trim())
      for (const background of ['--surface', '--danger-soft']) {
        const surface = luminance(tokens.style.getPropertyValue(background).trim())
        expect(
          (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05),
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('uses Safari 16-compatible container query syntax in every public stylesheet', () => {
    for (const path of ['public.css', 'SlotPicker.css', 'embed.css']) {
      const source = readFileSync(`apps/web/src/public/${path}`, 'utf8')
      for (const query of source.matchAll(/@container\s+([^{]+)\{/g)) {
        expect(query[1], path).not.toMatch(/[<>]|\bwidth\s*=/)
      }
    }
  })
})

it('renders host card descriptions with the preserved-line clamp hook', async () => {
  const description = 'First line\nSecond line\nThird line\nFourth line'
  fakeApi({
    'GET /api/v1/public/ada': () =>
      json(200, { handle: 'ada', host: EVENT.host, eventTypes: [{ ...EVENT, description }] }),
  })
  renderApp('/ada')
  const card = await screen.findByRole('link', { name: /Intro call/ })
  expect(
    within(card)
      .getByText(description, { normalizer: (value) => value })
      .classList.contains('event-card-description'),
  ).toBe(true)
})

it.each(['\n', '\r\n', '\r'])(
  'collapses blank host description lines before the three-line clamp (%j)',
  async (newline) => {
    const description = [
      '',
      'First line',
      '  \t',
      '',
      'Second line',
      '',
      'Third line',
      'Fourth line',
      '',
    ].join(newline)
    fakeApi({
      'GET /api/v1/public/ada': () =>
        json(200, { handle: 'ada', host: EVENT.host, eventTypes: [{ ...EVENT, description }] }),
    })
    renderApp('/ada')
    const card = await screen.findByRole('link', { name: /Intro call/ })
    expect(card.querySelector('.event-card-description')?.textContent).toBe(
      'First line\nSecond line\nThird line\nFourth line',
    )
  },
)
