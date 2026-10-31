import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeApi, json, renderApp } from '../test/fake-api.tsx'
import { EVENT, eventRoutes, managed, TOKEN } from '../test/public-fixtures.ts'

const publicStyles = readFileSync('apps/web/src/public/public.css', 'utf8')
const pickerStyles = readFileSync('apps/web/src/public/SlotPicker.css', 'utf8')
const appStyles = readFileSync('apps/web/src/styles.css', 'utf8')

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

function luminance(color: string) {
  const channels = color
    .slice(1)
    .match(/../g)
    ?.map((channel) => {
      const value = Number.parseInt(channel, 16) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
  if (!/^#[\da-f]{6}$/i.test(color) || !channels) throw new Error(`Unsupported color: ${color}`)
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
}

describe('public overflow protections', () => {
  it('removes title top spacing only when the host identity follows it', () => {
    render(
      <div className="public">
        <aside>
          <h1 className="event-title">Intro call</h1>
          <div className="host-identity">
            <p className="event-host">Ada Lovelace</p>
          </div>
        </aside>
        <aside>
          <h1 className="event-title">Another event</h1>
        </aside>
      </div>,
    )
    // jsdom needs concrete tokens to expand shorthand margins.
    const css = publicStyles
      .replaceAll('var(--space-1)', '4px')
      .replaceAll('var(--space-3)', '12px')
    inspectStyles(css, () => {
      expect(getComputedStyle(screen.getByRole('heading', { name: 'Intro call' })).marginTop).toBe(
        '0px',
      )
      expect(
        getComputedStyle(screen.getByRole('heading', { name: 'Another event' })).marginTop,
      ).toBe('4px')
    })
  })

  it('keeps the avatar fixed while long host names can shrink and wrap beside it', () => {
    inspectStyles(publicStyles, (rules) => {
      const identity = declarations(rules, '.public .host-identity')
      expect(identity.getPropertyValue('display')).toBe('flex')
      const name = declarations(rules, '.public .host-identity > .event-host')
      expect(name.getPropertyValue('min-width')).toBe('0px')
      expect(name.getPropertyValue('overflow-wrap')).toBe('anywhere')
      const avatar = declarations(rules, '.public .host-avatar')
      expect(avatar.getPropertyValue('flex-shrink')).toBe('0')
      expect(avatar.getPropertyValue('width')).toBe('48px')
      expect(avatar.getPropertyValue('height')).toBe('48px')
      const image = declarations(rules, '.public .host-avatar img')
      expect(image.getPropertyValue('width')).toBe('100%')
      expect(image.getPropertyValue('height')).toBe('100%')
      expect(image.getPropertyValue('object-fit')).toBe('cover')
    })
  })

  it('uses readable brand tokens for initials in both light and dark themes', () => {
    inspectStyles(publicStyles, (rules) => {
      const avatar = declarations(rules, '.public .host-avatar')
      expect(avatar.getPropertyValue('background')).toBe('var(--accent-soft)')
      expect(avatar.getPropertyValue('color')).toBe('var(--accent-soft-text)')
      const name = declarations(rules, '.public .host-identity > .event-host')
      expect(name.getPropertyValue('color')).toBe('var(--text)')
      expect(name.getPropertyValue('font-size')).toBe('var(--text-lg)')
    })
    inspectStyles(appStyles, (rules) => {
      const light = declarations(rules, ':root')
      const dark = rules.find(
        (rule) =>
          'selectorText' in rule &&
          (rule as CSSStyleRule).selectorText === ':root' &&
          (rule.parentRule as CSSMediaRule | null)?.conditionText ===
            '(prefers-color-scheme: dark)',
      ) as CSSStyleRule | undefined
      expect(dark).toBeDefined()
      for (const theme of [light, (dark as CSSStyleRule).style]) {
        const color = (name: string): string => {
          const value = theme.getPropertyValue(name).trim() || light.getPropertyValue(name).trim()
          const variable = /^var\((--[\w-]+)\)$/.exec(value)?.[1]
          return variable ? color(variable) : value
        }
        const foreground = luminance(color('--accent-soft-text'))
        const background = luminance(color('--accent-soft'))
        expect(
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
        ).toBeGreaterThanOrEqual(4.5)
      }
    })
  })

  it('allows public action labels to wrap inside narrow cards', () => {
    inspectStyles(publicStyles, (rules) => {
      expect(declarations(rules, '.public .button').getPropertyValue('white-space')).toBe('normal')
    })
  })

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

  it('keeps host zone segments together between the slash break opportunities', () => {
    inspectStyles(publicStyles, (rules) => {
      expect(
        declarations(rules, '.public .host-time-zone .time-zone-segment').getPropertyValue(
          'white-space',
        ),
      ).toBe('nowrap')
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
