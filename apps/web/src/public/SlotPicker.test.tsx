import { readFileSync } from 'node:fs'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentProps, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { slot } from '../test/public-fixtures.ts'
import type { Slot, SlotLoader } from './api.ts'
import { SlotPicker, type SlotPickerPosition } from './SlotPicker.tsx'

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

const positionFallback =
  'The date you were viewing is no longer available. Please pick another day.'
const november = { year: 2026, month: 11 }
const december = { year: 2026, month: 12 }

function answerWith(...starts: string[]) {
  const times = starts.map((start) => slot(start))
  return vi.fn<SlotLoader>(async (start, end) =>
    times.filter(
      (time) =>
        Date.parse(time.start) >= Date.parse(start) && Date.parse(time.end) <= Date.parse(end),
    ),
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function positionProps(overrides: Partial<ComponentProps<typeof SlotPicker>> = {}) {
  return {
    load: answerWith('2026-11-02T14:00:00Z'),
    durationMinutes: 30,
    timeZone: 'UTC',
    onTimeZoneChange: vi.fn(),
    locale: 'en-US',
    now: Date.parse('2026-11-01T00:00:00Z'),
    selected: null,
    onSelect: vi.fn(),
    version: 0,
    ...overrides,
  }
}

function expectPositionFallback() {
  const message = screen.getByText(positionFallback)
  expect(message.closest('[role="status"], [role="alert"]')).not.toBeNull()
}

function PositionFlow({ load }: { load: SlotLoader }) {
  const [position, setPosition] = useState<SlotPickerPosition | null>(null)
  const [showPicker, setShowPicker] = useState(true)
  return showPicker ? (
    <>
      <SlotPicker
        {...positionProps({ load })}
        initialPosition={position}
        onPositionChange={setPosition}
        onSelect={() => setShowPicker(false)}
        focusTitle
      />
      <button type="button" onClick={() => setShowPicker(false)}>
        Leave picker
      </button>
    </>
  ) : (
    <button type="button" onClick={() => setShowPicker(true)}>
      Back to picker
    </button>
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

describe('slot picker browsing position', () => {
  it('restores the browsed month and chosen day after the flow unmounts and rebuilds it', async () => {
    const user = userEvent.setup()
    const load = answerWith('2026-11-02T14:00:00Z', '2026-12-05T15:00:00Z')
    render(<PositionFlow load={load} />)
    await screen.findByRole('button', { name: /November 2, available/ })
    await user.click(screen.getByRole('button', { name: 'Next month' }))
    await user.click(await screen.findByRole('button', { name: /December 5, available/ }))
    await user.click(screen.getByRole('button', { name: '3:00 PM' }))
    expect(screen.queryByRole('grid')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Back to picker' }))
    const restored = await screen.findByRole('button', { name: /December 5, available/ })
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
    expect(restored.classList.contains('day-selected')).toBe(true)
    expect(screen.getByRole('list', { name: 'Times on Saturday, December 5' })).toBeDefined()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Pick a time' }))
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('keeps an empty month that the visitor browsed to, including after remount', async () => {
    const user = userEvent.setup()
    const load = answerWith('2026-11-02T14:00:00Z')
    render(<PositionFlow load={load} />)
    await screen.findByRole('button', { name: /November 2, available/ })
    await user.click(screen.getByRole('button', { name: 'Next month' }))
    await screen.findByText('No available times this month.')
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Leave picker' }))
    await user.click(screen.getByRole('button', { name: 'Back to picker' }))
    await screen.findByText('No available times this month.')
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('retains a restored day during loading and reports it when its slots arrive', async () => {
    const pending = deferred<Slot[]>()
    const onPositionChange = vi.fn()
    render(
      <SlotPicker
        {...positionProps({ load: () => pending.promise })}
        initialPosition={{ month: december, day: '2026-12-05' }}
        onPositionChange={onPositionChange}
      />,
    )
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Saturday, December 5' })).toBeDefined()
    expect(screen.getByRole('grid').getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText(positionFallback)).toBeNull()
    expect(onPositionChange).not.toHaveBeenCalledWith({ month: december, day: null })
    await act(async () => pending.resolve([slot('2026-12-05T15:00:00Z')]))
    expect(screen.getByRole('button', { name: '3:00 PM' })).toBeDefined()
    expect(onPositionChange).toHaveBeenLastCalledWith({ month: december, day: '2026-12-05' })
  })

  it('clears an unavailable restored day only after the current response and announces why', async () => {
    const pending = deferred<Slot[]>()
    const onPositionChange = vi.fn()
    render(
      <SlotPicker
        {...positionProps({ load: () => pending.promise })}
        initialPosition={{ month: december, day: '2026-12-05' }}
        onPositionChange={onPositionChange}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Saturday, December 5' })).toBeDefined()
    await act(async () => pending.resolve([slot('2026-12-06T15:00:00Z')]))
    expect(screen.queryByRole('heading', { name: 'Saturday, December 5' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
    expect(screen.getByText('Pick a day to see its times.')).toBeDefined()
    expectPositionFallback()
    expect(onPositionChange).toHaveBeenLastCalledWith({ month: december, day: null })
  })

  it('clears a restored date with no available days without jumping away from its month', async () => {
    const load = answerWith()
    render(
      <SlotPicker
        {...positionProps({ load })}
        initialPosition={{ month: november, day: '2026-11-02' }}
      />,
    )
    await screen.findByText('No available times this month.')
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeDefined()
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Monday, November 2' })).toBeNull(),
    )
    expectPositionFallback()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['past', { year: 2026, month: 10 }],
    ['beyond the browsing window', { year: 2028, month: 12 }],
    ['invalid month', { year: 2026, month: 13 }],
    ['noninteger month', { year: 2026, month: 11.5 }],
    ['noninteger year', { year: 2026.5, month: 11 }],
    ['invalid year', { year: Number.NaN, month: 11 }],
  ])('falls back from a restored %s to the accessible current month', async (_name, month) => {
    const onPositionChange = vi.fn()
    const load = answerWith('2026-11-02T14:00:00Z')
    render(
      <SlotPicker
        {...positionProps({ load })}
        initialPosition={{ month, day: '2026-11-02' }}
        onPositionChange={onPositionChange}
      />,
    )
    expect(onPositionChange).not.toHaveBeenCalledWith({ month, day: '2026-11-02' })
    await screen.findByRole('button', { name: /November 2, available/ })
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Previous month' }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(screen.queryByRole('heading', { name: 'Monday, November 2' })).toBeNull()
    expectPositionFallback()
    expect(onPositionChange).toHaveBeenLastCalledWith({ month: november, day: null })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['malformed', 'not-a-date'],
    ['nonexistent', '2026-11-31'],
    ['noncanonical', '2026-11-2'],
    ['zero day', '2026-11-00'],
    ['different month', '2026-12-02'],
    ['past', '2026-11-01'],
  ])('clears a restored %s day while keeping its valid month', async (_name, day) => {
    const onPositionChange = vi.fn()
    render(
      <SlotPicker
        {...positionProps({ now: Date.parse('2026-11-02T00:00:00Z') })}
        initialPosition={{ month: november, day }}
        onPositionChange={onPositionChange}
      />,
    )
    expect(onPositionChange).not.toHaveBeenCalledWith({ month: november, day })
    await screen.findByRole('button', { name: /November 2, available/ })
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeDefined()
    expect(screen.queryByRole('list', { name: /^Times on/ })).toBeNull()
    expectPositionFallback()
    expect(onPositionChange).toHaveBeenLastCalledWith({ month: november, day: null })
  })

  it('bounds a restored month again after time has advanced while the picker was unmounted', async () => {
    const load = answerWith('2026-12-02T14:00:00Z')
    const onPositionChange = vi.fn()
    render(
      <SlotPicker
        {...positionProps({ load, now: Date.parse('2026-12-01T00:00:00Z') })}
        initialPosition={{ month: november, day: '2026-11-30' }}
        onPositionChange={onPositionChange}
      />,
    )
    await screen.findByRole('button', { name: /December 2, available/ })
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
    expectPositionFallback()
    expect(onPositionChange).toHaveBeenLastCalledWith({ month: december, day: null })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('rejects a zero day in a valid future month before loading', async () => {
    const pending = deferred<Slot[]>()
    const onPositionChange = vi.fn()
    render(
      <SlotPicker
        {...positionProps({ load: () => pending.promise, onPositionChange })}
        initialPosition={{ month: december, day: '2026-12-00' }}
      />,
    )
    expect(onPositionChange).not.toHaveBeenCalledWith({ month: december, day: '2026-12-00' })
    expect(onPositionChange).toHaveBeenLastCalledWith({ month: december, day: null })
    expectPositionFallback()
    await act(async () => pending.resolve([slot('2026-12-05T15:00:00Z')]))
    expect(screen.getByRole('button', { name: /December 5, available/ })).toBeDefined()
  })

  it('clears a day that becomes past while mounted without waiting for its refreshed request', async () => {
    const pending = deferred<Slot[]>()
    const load = vi.fn<SlotLoader>().mockResolvedValueOnce([slot('2026-11-02T14:00:00Z')])
    load.mockImplementation(() => pending.promise)
    const onPositionChange = vi.fn()
    const props = positionProps({ load, onPositionChange })
    const view = render(
      <SlotPicker {...props} initialPosition={{ month: november, day: '2026-11-02' }} />,
    )
    await screen.findByRole('button', { name: '2:00 PM' })
    view.rerender(
      <SlotPicker
        {...props}
        now={Date.parse('2026-11-03T00:00:00Z')}
        initialPosition={{ month: november, day: '2026-11-02' }}
      />,
    )
    expect(screen.queryByRole('heading', { name: 'Monday, November 2' })).toBeNull()
    expectPositionFallback()
    expect(onPositionChange).toHaveBeenLastCalledWith({ month: november, day: null })
    expect(screen.getByRole('grid').getAttribute('aria-busy')).toBe('true')
    await act(async () => pending.resolve([]))
  })

  it('regroups slots across a local day change and clears the lost day without reloading', async () => {
    const load = answerWith('2026-11-02T14:00:00Z')
    const onPositionChange = vi.fn()
    const props = positionProps({ load, onPositionChange })
    const view = render(
      <SlotPicker {...props} initialPosition={{ month: november, day: '2026-11-02' }} />,
    )
    await screen.findByRole('button', { name: '2:00 PM' })
    view.rerender(
      <SlotPicker
        {...props}
        timeZone="Pacific/Kiritimati"
        initialPosition={{ month: november, day: '2026-11-02' }}
      />,
    )
    const regrouped = await screen.findByRole('button', { name: /November 3, available/ })
    expect(screen.queryByRole('list', { name: /^Times on/ })).toBeNull()
    expectPositionFallback()
    expect(onPositionChange).toHaveBeenLastCalledWith({ month: november, day: null })
    expect(load).toHaveBeenCalledTimes(1)
    await userEvent.click(regrouped)
    expect(screen.getByRole('button', { name: '4:00 AM' })).toBeDefined()
    expect(onPositionChange).toHaveBeenLastCalledWith({ month: november, day: '2026-11-03' })
  })

  it('keeps the browsed month when a timezone moves all its slots to the next month', async () => {
    const user = userEvent.setup()
    const load = answerWith('2026-11-30T23:30:00Z')
    const props = positionProps({ load })
    const view = render(
      <SlotPicker {...props} initialPosition={{ month: november, day: '2026-11-30' }} />,
    )
    await screen.findByRole('button', { name: '11:30 PM' })
    view.rerender(
      <SlotPicker
        {...props}
        timeZone="Pacific/Kiritimati"
        initialPosition={{ month: november, day: '2026-11-30' }}
      />,
    )
    await screen.findByText('No available times this month.')
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeDefined()
    expectPositionFallback()
    expect(load).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Next month' }))
    await user.click(await screen.findByRole('button', { name: /December 1, available/ }))
    expect(screen.getByRole('button', { name: '1:30 PM' })).toBeDefined()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps a day the visitor chose in a fresh picker from triggering a timezone auto-jump', async () => {
    const load = answerWith('2026-11-30T23:30:00Z')
    const props = positionProps({ load })
    const view = render(<SlotPicker {...props} />)
    await userEvent.click(await screen.findByRole('button', { name: /November 30, available/ }))
    expect(screen.getByRole('button', { name: '11:30 PM' })).toBeDefined()
    view.rerender(<SlotPicker {...props} timeZone="Pacific/Kiritimati" />)
    await screen.findByText('No available times this month.')
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Monday, November 30' })).toBeNull()
    expectPositionFallback()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('bounds the month when changing timezone makes today move into the next month', async () => {
    const load = answerWith('2026-11-30T15:00:00Z')
    const onPositionChange = vi.fn()
    const props = positionProps({
      load,
      now: Date.parse('2026-11-30T12:00:00Z'),
      onPositionChange,
    })
    const view = render(
      <SlotPicker {...props} initialPosition={{ month: november, day: '2026-11-30' }} />,
    )
    await screen.findByRole('button', { name: '3:00 PM' })
    view.rerender(
      <SlotPicker
        {...props}
        timeZone="Pacific/Kiritimati"
        initialPosition={{ month: november, day: '2026-11-30' }}
      />,
    )
    await screen.findByRole('button', { name: /December 1, available/ })
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Previous month' }).hasAttribute('disabled')).toBe(
      true,
    )
    expectPositionFallback()
    expect(onPositionChange).toHaveBeenLastCalledWith({ month: december, day: null })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('still automatically advances a fresh empty picker at most two months', async () => {
    const first = deferred<Slot[]>()
    const second = deferred<Slot[]>()
    const third = deferred<Slot[]>()
    const load = vi
      .fn<SlotLoader>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise)
      .mockResolvedValue([])
    render(<SlotPicker {...positionProps({ load })} />)
    await act(async () => first.resolve([]))
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
    await act(async () => second.resolve([]))
    expect(screen.getByRole('heading', { name: 'January 2027' })).toBeDefined()
    await act(async () => third.resolve([]))
    expect(screen.getByRole('heading', { name: 'January 2027' })).toBeDefined()
    expect(screen.getByText('No available times this month.')).toBeDefined()
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('stops the fresh automatic month advance as soon as a month has times', async () => {
    const load = answerWith('2026-12-05T15:00:00Z')
    render(<SlotPicker {...positionProps({ load })} />)
    await screen.findByRole('button', { name: /December 5, available/ })
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not let delayed empty responses override a month the visitor browsed to', async () => {
    const previous = deferred<Slot[]>()
    const current = deferred<Slot[]>()
    const load = vi.fn<SlotLoader>()
    load.mockImplementationOnce(() => previous.promise).mockImplementation(() => current.promise)
    render(<SlotPicker {...positionProps({ load })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }))
    await act(async () => current.resolve([]))
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
    expect(screen.getByText('No available times this month.')).toBeDefined()
    await act(async () => previous.resolve([]))
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps in-month keyboard browsing in place when a fresh empty response arrives', async () => {
    const pending = deferred<Slot[]>()
    const load = vi.fn<SlotLoader>(() => pending.promise)
    render(<SlotPicker {...positionProps({ load })} />)
    const today = screen.getByRole('button', { name: /November 1, loading/ })
    expect(today.tabIndex).toBe(0)
    today.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement?.getAttribute('data-day')).toBe('2026-11-02')
    await act(async () => pending.resolve([]))
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeDefined()
    expect(screen.getByText('No available times this month.')).toBeDefined()
    expect(document.activeElement?.getAttribute('data-day')).toBe('2026-11-02')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('discards a prior month response that arrives after restored current-month slots', async () => {
    const previous = deferred<Slot[]>()
    const current = deferred<Slot[]>()
    const load = vi.fn<SlotLoader>()
    load.mockImplementationOnce(() => previous.promise).mockImplementation(() => current.promise)
    const onPositionChange = vi.fn()
    render(
      <SlotPicker
        {...positionProps({ load, onPositionChange })}
        initialPosition={{ month: november, day: '2026-11-02' }}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(load.mock.calls[0]?.[2].aborted).toBe(true)
    await act(async () => current.resolve([slot('2026-12-05T15:00:00Z')]))
    await userEvent.click(screen.getByRole('button', { name: /December 5, available/ }))
    await act(async () => previous.resolve([slot('2026-12-06T16:00:00Z')]))
    expect(screen.getByRole('button', { name: '3:00 PM' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /December 6, available/ })).toBeNull()
    expect(screen.getByRole('grid').getAttribute('aria-busy')).toBe('false')
    expect(onPositionChange).toHaveBeenLastCalledWith({ month: december, day: '2026-12-05' })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps the restored day selected while a version reload is pending', async () => {
    const pending = deferred<Slot[]>()
    const load = vi.fn<SlotLoader>().mockResolvedValueOnce([slot('2026-12-05T15:00:00Z')])
    load.mockImplementation(() => pending.promise)
    const onPositionChange = vi.fn()
    const props = positionProps({ load, onPositionChange })
    const view = render(
      <SlotPicker {...props} initialPosition={{ month: december, day: '2026-12-05' }} />,
    )
    await screen.findByRole('button', { name: '3:00 PM' })
    view.rerender(
      <SlotPicker
        {...props}
        version={1}
        initialPosition={{ month: december, day: '2026-12-05' }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Saturday, December 5' })).toBeDefined()
    expect(screen.getByRole('grid').getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText(positionFallback)).toBeNull()
    expect(onPositionChange).not.toHaveBeenCalledWith({ month: december, day: null })
    await act(async () => pending.resolve([]))
    expect(screen.queryByRole('heading', { name: 'Saturday, December 5' })).toBeNull()
    expectPositionFallback()
    expect(onPositionChange).toHaveBeenLastCalledWith({ month: december, day: null })
  })

  it('keeps heading focus and calendar keyboard navigation when restoring a selected day', async () => {
    const user = userEvent.setup()
    const load = answerWith('2026-12-05T15:00:00Z', '2027-01-06T15:00:00Z')
    render(
      <SlotPicker
        {...positionProps({ load, focusTitle: true })}
        initialPosition={{ month: december, day: '2026-12-05' }}
      />,
    )
    const restored = await screen.findByRole('button', { name: /December 5, available/ })
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Pick a time' }))
    expect(restored.tabIndex).toBe(0)
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.classList.contains('day') && button.tabIndex === 0),
    ).toEqual([restored])
    restored.focus()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement?.getAttribute('data-day')).toBe('2026-12-06')
    await user.keyboard('{PageDown}')
    await waitFor(() => expect(document.activeElement?.getAttribute('data-day')).toBe('2027-01-06'))
    expect(screen.queryByText(positionFallback)).toBeNull()
    await user.keyboard('{PageUp}')
    await waitFor(() => expect(document.activeElement?.getAttribute('data-day')).toBe('2026-12-06'))
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
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

  it('keeps coarse-pointer day targets 44px tall while the calendar never outgrows its track', () => {
    const css = rules(styles)
    const coarse = css.filter(
      (rule) => (rule.parentRule as CSSMediaRule | null)?.conditionText === '(pointer: coarse)',
    )
    expect(declaration(coarse, '.picker .day', 'min-height')).toBe('44px')
    expect(declaration(coarse, '.picker .calendar-grid', 'border-spacing')).toBe('0px')
    // Seven columns share the track width: a 44px day minimum would overflow 320px cards.
    expect(declaration(coarse, '.picker .day', 'min-width')).toBe('')
    expect(declaration(css, '.picker .day', 'width')).toBe('100%')
    // The track bounds the calendar; a 308px minimum spilled over narrow cards symmetrically.
    const calendar = css.filter((rule) => rule.selectorText === '.picker .picker-calendar')
    expect(calendar.length).toBeGreaterThan(0)
    for (const rule of calendar) {
      expect(rule.style.getPropertyValue('min-width')).toBe('')
      expect(rule.style.getPropertyValue('justify-self')).toBe('')
    }
    expect(declaration(css, '.picker .picker-calendar', 'width')).toBe('100%')
    // Day labels follow the column width instead, so bold 22日 fits a 36px cell on one line.
    expect(styles).toMatch(/\.picker \.picker-calendar \{[^}]*container-type: inline-size;/)
    expect(styles).toMatch(/\.picker \.day \{[^}]*font-size: min\(1rem, 5\.3cqw\);/)
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
