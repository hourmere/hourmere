import { readFileSync } from 'node:fs'
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeApi, json, renderApp } from '../test/fake-api.tsx'
import { EVENT, eventRoutes, managed, TOKEN } from '../test/public-fixtures.ts'

const publicStyles = readFileSync('apps/web/src/public/public.css', 'utf8')
const pickerStyles = readFileSync('apps/web/src/public/SlotPicker.css', 'utf8')

/** Inspect the real declarations: jsdom does not calculate intrinsic sizes or scroll clipping. */
function inspectStyles(css: string, inspect: (rules: CSSRule[]) => void) {
  const style = document.createElement('style')
  style.textContent = css.replace(/^@import[^;]+;/m, '')
  document.head.append(style)
  try {
    const rules: CSSRule[] = []
    function collect(list: CSSRuleList) {
      for (const rule of list) {
        rules.push(rule)
        if ('cssRules' in rule) collect((rule as CSSGroupingRule).cssRules)
      }
    }
    collect((style.sheet as CSSStyleSheet).cssRules)
    inspect(rules)
  } finally {
    style.remove()
  }
}

function declarations(rules: CSSRule[], selector: string) {
  const rule = rules.find(
    (rule) => 'selectorText' in rule && (rule as CSSStyleRule).selectorText === selector,
  ) as CSSStyleRule | undefined
  expect(rule, `missing rule for ${selector}`).toBeDefined()
  return (rule as CSSStyleRule).style
}

describe('public overflow protections', () => {
  it('uses zero-minimum tracks for the public frame, cards and stacked booking layout', () => {
    inspectStyles(publicStyles, (rules) => {
      for (const selector of [
        '.public',
        '.public .event-list',
        '.public .event-card',
        '.public .booking-layout',
      ]) {
        expect(declarations(rules, selector).getPropertyValue('grid-template-columns')).toBe(
          'minmax(0, 1fr)',
        )
      }
    })
  })

  it('lets public user content wrap anywhere and grid or flex children shrink', () => {
    inspectStyles(publicStyles, (rules) => {
      expect(declarations(rules, '.public .user-content').getPropertyValue('overflow-wrap')).toBe(
        'anywhere',
      )
      for (const selector of [
        '.public > *',
        '.public .public-main > *',
        '.public .event-list > *',
        '.public .event-card > *',
        '.public .booking-layout > *',
        '.public .event-facts > *',
        '.public .guest > *',
        '.public .details-row > *',
        '.public .choice > span',
      ]) {
        const rule = rules.find(
          (rule) =>
            'selectorText' in rule &&
            (rule as CSSStyleRule).selectorText.split(',').some((part) => part.trim() === selector),
        ) as CSSStyleRule | undefined
        expect(rule?.style.getPropertyValue('min-width'), selector).toBe('0px')
      }
    })
  })

  it('keeps the narrow picker track and time zone names shrinkable', () => {
    inspectStyles(pickerStyles, (rules) => {
      expect(
        declarations(rules, '.picker .picker-body').getPropertyValue('grid-template-columns'),
      ).toBe('minmax(0, 1fr)')
      expect(declarations(rules, '.picker .picker-body > *').getPropertyValue('min-width')).toBe(
        '0px',
      )
      expect(
        declarations(rules, ':is(.public, .picker) .tz-toggle').getPropertyValue(
          'grid-template-columns',
        ),
      ).toBe('minmax(0, 1fr) auto')
      for (const selector of [
        ':is(.public, .picker) .tz-current',
        ':is(.public, .picker) .tz-option > :first-child',
      ]) {
        expect(declarations(rules, selector).getPropertyValue('min-width')).toBe('0px')
        expect(declarations(rules, selector).getPropertyValue('overflow-wrap')).toBe('anywhere')
      }
      expect(
        declarations(rules, ':is(.public, .picker) .tz-option').getPropertyValue('padding'),
      ).toBe('var(--space-2) var(--space-3)')
    })
  })

  it('leaves focus-outline space on every side of the scrollable slot list after the reset', () => {
    inspectStyles(pickerStyles, (rules) => {
      const slotRules = rules.filter(
        (rule) =>
          'selectorText' in rule && (rule as CSSStyleRule).selectorText === '.picker .slots',
      ) as CSSStyleRule[]
      const scrollable = slotRules.find(
        (rule) => rule.style.getPropertyValue('overflow-y') === 'auto',
      )
      expect(scrollable).toBeDefined()
      expect(scrollable?.style.getPropertyValue('padding')).toBe('var(--space-2)')
      expect(slotRules.at(-1)).toBe(scrollable)
      expect((scrollable?.parentRule as CSSMediaRule | undefined)?.conditionText).toBe(
        '(min-width: 640px)',
      )
    })
  })
})

const longName = 'Alexandria'.repeat(20)
const longTitle = 'Consultation'.repeat(16)
const longUrl = `https://docs.example.com/${'long-unbroken-path'.repeat(25)}`
const longEmail = `${'longemail'.repeat(20)}@example.com`
const longEvent = {
  ...EVENT,
  title: longTitle,
  description: longUrl,
  host: { ...EVENT.host, name: longName },
}

afterEach(() => window.history.replaceState(null, '', '/'))

function expectWrappingContent(element: HTMLElement) {
  expect(element.closest('.user-content')).toBe(screen.getByRole('main'))
}

describe('public user-content coverage', () => {
  it('includes long host names, event titles and descriptions in the wrapping scope', async () => {
    fakeApi({
      'GET /api/v1/public/ada': () =>
        json(200, {
          handle: 'ada',
          host: longEvent.host,
          eventTypes: [longEvent],
        }),
    })
    renderApp('/ada')
    expectWrappingContent(await screen.findByRole('heading', { name: longName }))
    expectWrappingContent(screen.getByText(longTitle))
    expectWrappingContent(screen.getByText(longUrl))
  })

  it.each(['/ada/intro', '/embed/ada/intro'])(
    'includes event and host text in the wrapping scope at %s',
    async (path) => {
      fakeApi(eventRoutes(longEvent, ['2026-11-02T14:00:00Z']))
      renderApp(path)
      expectWrappingContent(await screen.findByRole('heading', { name: longTitle }))
      expectWrappingContent(screen.getByText(longName))
      expectWrappingContent(screen.getByText(longUrl))
    },
  )

  it('includes management locations, names and emails in the wrapping scope', async () => {
    fakeApi({
      'GET /api/v1/bookings/manage': () =>
        json(
          200,
          managed({
            location: { kind: 'link', url: longUrl },
            attendees: [
              {
                name: longName,
                email: longEmail,
                timeZone: 'UTC',
                locale: 'en',
                isBooker: true,
              },
            ],
          }),
        ),
    })
    renderApp(`/booking#token=${TOKEN}`)
    expectWrappingContent(await screen.findByRole('link', { name: longUrl }))
    expectWrappingContent(screen.getByText(`${longName} (${longEmail})`))
  })
})
