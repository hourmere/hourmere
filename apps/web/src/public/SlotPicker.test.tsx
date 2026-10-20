import { readFileSync } from 'node:fs'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { slot } from '../test/public-fixtures.ts'
import { SlotPicker } from './SlotPicker.tsx'

const styles = readFileSync('apps/web/src/public/SlotPicker.css', 'utf8')
const tokens = readFileSync('apps/web/src/styles.css', 'utf8')
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
afterEach(() => {
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})
const slots = [slot('2026-11-02T14:00:00Z'), slot('2026-11-03T14:00:00Z')]

function picker() {
  return render(
    <SlotPicker
      load={async () => slots}
      durationMinutes={30}
      timeZone="UTC"
      onTimeZoneChange={vi.fn()}
      locale="en-US"
      now={Date.parse('2026-11-01T00:00Z')}
      selected={slots[0] ?? null}
      onSelect={vi.fn()}
      version={0}
    />,
  )
}

function media(narrow: boolean, reduced: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width') ? narrow : reduced,
  }))
}

function rules(css: string): CSSStyleRule[] {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  const sheet = style.sheet as CSSStyleSheet
  const result: CSSStyleRule[] = []
  function collect(list: CSSRuleList) {
    for (const rule of list) {
      if ('selectorText' in rule) result.push(rule as CSSStyleRule)
      if ('cssRules' in rule) collect((rule as CSSGroupingRule).cssRules)
    }
  }
  collect(sheet.cssRules)
  style.remove()
  return result
}

function declaration(css: CSSStyleRule[], selector: string, property: string) {
  const rule = css.find(
    (rule) => rule.selectorText.replace(/\s+/g, ' ') === selector.replace(/\s+/g, ' '),
  )
  expect(rule, selector).toBeDefined()
  return rule?.style.getPropertyValue(property)
}

function contrast(first: string, second: string) {
  const luminance = (hex: string) => {
    const values = hex.match(/[a-f\d]{2}/gi)?.map((value) => {
      const channel = Number.parseInt(value, 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    if (values?.length !== 3) throw new Error(`Expected hex colour: ${hex}`)
    return (values[0] ?? 0) * 0.2126 + (values[1] ?? 0) * 0.7152 + (values[2] ?? 0) * 0.0722
  }
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05)
}

describe('slot picker polish', () => {
  it.each([false, true])(
    'scrolls to the chosen day on narrow screens (reduced motion: %s)',
    async (reduced) => {
      media(true, reduced)
      const scroll = vi.fn()
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: scroll,
      })
      const user = userEvent.setup()
      picker()
      expect(scroll).not.toHaveBeenCalled()
      await user.click(await screen.findByRole('button', { name: /November 2, available/ }))
      expect(scroll).toHaveBeenCalledWith({
        block: 'start',
        behavior: reduced ? 'instant' : 'smooth',
      })
      expect(scroll.mock.instances.at(-1)).toBe(
        screen.getByRole('heading', { name: 'Monday, November 2' }),
      )
      expect(document.activeElement?.getAttribute('data-day')).toBe('2026-11-02')
    },
  )

  it('keeps desktop calendar selection in place', async () => {
    media(false, false)
    const scroll = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scroll,
    })
    picker()
    await userEvent.click(await screen.findByRole('button', { name: /November 2, available/ }))
    expect(scroll).not.toHaveBeenCalled()
  })

  it('scrolls again when the same available day is chosen twice', async () => {
    media(true, false)
    const scroll = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scroll,
    })
    const user = userEvent.setup()
    picker()
    const day = await screen.findByRole('button', { name: /November 2, available/ })
    await user.click(day)
    await user.click(day)
    expect(scroll).toHaveBeenCalledTimes(2)
    expect(scroll.mock.instances[1]).toBe(
      screen.getByRole('heading', { name: 'Monday, November 2' }),
    )
  })

  it('shows a scroll hint only while more slots remain below the scrollport', async () => {
    picker()
    await userEvent.click(await screen.findByRole('button', { name: /November 2, available/ }))
    const list = screen.getByRole('list', { name: 'Times on Monday, November 2' })
    expect(list.parentElement?.className).toBe('slots-scroll')
    expect(list.parentElement?.getAttribute('data-more')).toBe('false')
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 840 },
      clientHeight: { configurable: true, value: 420 },
    })
    fireEvent.scroll(list)
    expect(list.parentElement?.getAttribute('data-more')).toBe('true')
    list.scrollTop = 420
    fireEvent.scroll(list)
    expect(list.parentElement?.getAttribute('data-more')).toBe('false')
    expect(screen.getByRole('button', { name: '2:00 PM' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(
      screen.getByRole('button', { name: '2:00 PM' }).classList.contains('slot-selected'),
    ).toBe(true)
  })

  it('distinguishes available, unavailable, selected and today dates in the DOM', async () => {
    picker()
    const available = await screen.findByRole('button', { name: /November 2, available/ })
    expect(available.classList.contains('day-available')).toBe(true)
    expect(available.getAttribute('aria-disabled')).toBe('false')
    await userEvent.click(available)
    expect(available.classList.contains('day-selected')).toBe(true)
    const unavailable = screen.getByRole('button', { name: /November 1, no times available/ })
    expect(unavailable.getAttribute('aria-disabled')).toBe('true')
    expect(unavailable.getAttribute('aria-current')).toBe('date')
  })
})

describe('slot picker CSS contracts', () => {
  it('uses compact mobile slots, a bounded calendar and a single desktop slot column', () => {
    const css = rules(styles)
    expect(declaration(css, '.picker .day', 'border')).toBe('2px solid transparent')
    expect(declaration(css, '.picker .slots', 'grid-template-columns')).toBe(
      'repeat(auto-fill, minmax(88px, 1fr))',
    )
    expect(declaration(css, '.picker .picker-calendar', 'max-width')).toBe('360px')
    const desktop = css.find((rule) => rule.selectorText === '.picker .slots' && rule.parentRule)
    expect(desktop?.style.getPropertyValue('grid-template-columns')).toBe('minmax(0, 1fr)')
    expect((desktop?.parentRule as CSSMediaRule | undefined)?.conditionText).toBe(
      '(min-width: 640px)',
    )
  })

  it('marks unavailable days with a noncolour cue and uses 3:1 day and toggle borders in both themes', () => {
    const css = rules(styles)
    expect(declaration(css, '.picker .day[aria-disabled="true"]', 'opacity')).toBe('0.6')
    expect(declaration(css, '.picker .day[aria-disabled="true"]', 'text-decoration')).toBe('')
    expect(declaration(css, '.picker .day-available', 'border-color')).toBe('var(--border-strong)')
    expect(declaration(css, ':is(.public, .picker) .tz-toggle', 'border')).toBe(
      '1px solid var(--border-strong)',
    )
    const themes = rules(tokens).filter((rule) => rule.selectorText === ':root')
    expect(themes).toHaveLength(2)
    for (const theme of themes) {
      expect(
        contrast(
          theme.style.getPropertyValue('--border-strong'),
          theme.style.getPropertyValue('--surface'),
        ),
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('fits seven 44px day targets on coarse-pointer calendars', () => {
    const coarse = rules(styles).filter(
      (rule) => (rule.parentRule as CSSMediaRule | null)?.conditionText === '(pointer: coarse)',
    )
    expect(declaration(coarse, '.picker .day', 'min-width')).toBe('44px')
    expect(declaration(coarse, '.picker .day', 'min-height')).toBe('44px')
    expect(declaration(coarse, '.picker .calendar-grid', 'border-spacing')).toBe('0px')
    expect(declaration(coarse, '.picker .picker-calendar', 'min-width')).toBe('308px')
    expect(declaration(coarse, '.picker .picker-calendar', 'justify-self')).toBe('center')
  })

  it('adds a noninteractive fade above remaining slots', () => {
    const css = rules(styles)
    const selector = '.picker .slots-scroll[data-more="true"]::after'
    expect(declaration(css, selector, 'background')).toBe(
      'linear-gradient(transparent, var(--surface))',
    )
    expect(declaration(css, selector, 'pointer-events')).toBe('none')
  })

  it('preserves day, slot, highlighted time-zone and today states in forced colours', () => {
    const forced = rules(styles).filter(
      (rule) =>
        (rule.parentRule as CSSMediaRule | null)?.conditionText === '(forced-colors: active)',
    )
    expect(declaration(forced, '.picker .day-available', 'border-color')?.toLowerCase()).toBe(
      'buttontext',
    )
    expect(
      declaration(
        forced,
        '.picker .day-selected,\n.picker .slot-selected',
        'outline',
      )?.toLowerCase(),
    ).toBe('2px solid highlight')
    expect(
      declaration(forced, '.picker .day[aria-current="date"]::after', 'border')?.toLowerCase(),
    ).toBe('2px solid canvastext')
    expect(
      declaration(
        forced,
        ':is(.public, .picker) .tz-option[data-active="true"]',
        'outline',
      )?.toLowerCase(),
    ).toBe('2px solid highlight')
  })
})
