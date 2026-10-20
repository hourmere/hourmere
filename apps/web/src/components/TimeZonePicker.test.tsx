import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import * as time from '../public/time.ts'
import { matchTimeZones, TimeZonePicker, timeZoneNames } from './TimeZonePicker.tsx'

function Picker({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <label htmlFor="tz">Time zone</label>
      <TimeZonePicker value={value} onChange={setValue} control={{ id: 'tz' }} />
      <output data-testid="value">{value}</output>
    </>
  )
}

const box = () => screen.getByRole<HTMLInputElement>('combobox', { name: 'Time zone' })
const value = () => screen.getByTestId('value').textContent

describe('the time zone picker', () => {
  it('opens the public list at the selected zone in a current/common group', async () => {
    const scroll = vi.fn()
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scroll,
    })
    try {
      const user = userEvent.setup()
      render(<TimeZonePicker value="Pacific/Honolulu" onChange={vi.fn()} />)
      await user.click(screen.getByRole('button', { name: /Time zone/ }))
      const common = screen.getByRole('group', { name: 'Current and common time zones' })
      const current = within(common).getByRole('option', { name: /Pacific\/Honolulu/ })
      expect(within(common).getAllByRole('option')[0]).toBe(current)
      expect(within(common).getByRole('option', { name: /Asia\/Tokyo/ })).toBeDefined()
      expect(screen.getByRole('group', { name: 'All time zones' })).toBeDefined()
      expect(current.getAttribute('aria-selected')).toBe('true')
      expect(current.getAttribute('data-active')).toBe('true')
      expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toBe(current.id)
      expect(document.activeElement).toBe(screen.getByRole('combobox'))
      expect(scroll.mock.instances.at(-1)).toBe(current)
      expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' })
      await user.type(screen.getByRole('combobox'), 'tokyo')
      expect(screen.queryAllByRole('group')).toHaveLength(0)
      expect(screen.getAllByRole('option')).toHaveLength(1)
      expect(screen.getByRole('option').textContent).toMatch(/^Asia\/Tokyo/)
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original)
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  })

  it('offers breaks after each slash without changing the displayed or selected zone', async () => {
    const user = userEvent.setup()
    const id = 'America/Argentina/La_Rioja'
    const { container } = render(<TimeZonePicker value={id} onChange={vi.fn()} />)
    const current = container.querySelector<HTMLElement>('.tz-name')
    expect(current?.textContent).toBe('America/Argentina/La Rioja')
    expect(current?.style.overflowWrap).toBe('normal')
    expect(current?.querySelectorAll('wbr')).toHaveLength(2)
    for (const br of current?.querySelectorAll('wbr') ?? [])
      expect(br.previousSibling?.textContent?.endsWith('/')).toBe(true)
    await user.click(screen.getByRole('button', { name: /Time zone/ }))
    await user.type(screen.getByRole('combobox'), 'Argentina La Rioja')
    const option = screen.getByRole('option')
    const name = option.firstElementChild as HTMLElement
    expect(name.textContent).toBe('America/Argentina/La Rioja')
    expect(name.style.overflowWrap).toBe('normal')
    expect(name.querySelectorAll('wbr')).toHaveLength(2)
  })

  it('refreshes offsets and offset search for the reference date, including aliases', async () => {
    const user = userEvent.setup()
    const props = { value: 'US/Eastern', onChange: vi.fn(), now: Date.parse('2026-10-19T12:00Z') }
    const { rerender } = render(<TimeZonePicker {...props} referenceDate="2026-10-27" />)
    const toggle = screen.getByRole('button', { name: /Time zone/ })
    expect(toggle.textContent).toContain('GMT-04:00')
    rerender(<TimeZonePicker {...props} referenceDate="2026-11-03" />)
    expect(toggle.textContent).toContain('GMT-05:00')
    await user.click(toggle)
    await user.type(screen.getByRole('combobox'), 'US/Eastern GMT-05:00')
    expect(screen.getByRole('option').textContent).toBe('US/EasternGMT-05:00')
    rerender(<TimeZonePicker {...props} referenceDate="2026-10-27" />)
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('reuses zone offsets while typing a search', async () => {
    const offsets = vi.spyOn(time, 'offsetLabel')
    const user = userEvent.setup()
    render(<Picker />)
    const initial = offsets.mock.calls.length
    expect(initial).toBeGreaterThan(0)
    await user.type(box(), 'atlantis')
    expect(offsets).toHaveBeenCalledTimes(initial)
  })
  it('suggests zones while typing and picks one with the keyboard', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    expect(box().getAttribute('aria-expanded')).toBe('false')
    await user.type(box(), 'new y')
    expect(box().getAttribute('aria-expanded')).toBe('true')
    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent?.replace(/GMT.*$/, ''))).toEqual(['America/New York'])
    expect(box().getAttribute('aria-activedescendant')).toBe(options[0]?.id)
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{Enter}')
    expect(value()).toBe('America/New_York')
    expect(box().getAttribute('aria-expanded')).toBe('false')
  })

  it('moves through suggestions with the arrow keys and closes with Escape', async () => {
    const user = userEvent.setup()
    render(<Picker initial="Europe/Berlin" />)
    await user.click(box())
    await user.keyboard('{ArrowDown}')
    // Opening shows every zone, starting at the current one.
    const active = () => document.getElementById(box().getAttribute('aria-activedescendant') ?? '')
    expect(active()?.textContent).toMatch(/^Europe\/Berlin/)
    await user.keyboard('{ArrowDown}')
    expect(active()?.textContent).toMatch(/^Europe\/Bratislava/)
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(active()?.textContent).toMatch(/^Europe\/Belgrade/)
    await user.keyboard('{Escape}')
    expect(box().getAttribute('aria-expanded')).toBe('false')
    expect(value()).toBe('Europe/Berlin')
  })

  it('picks with the mouse', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    await user.type(box(), 'tokyo')
    await user.click(screen.getByRole('option', { name: /Asia\/Tokyo/ }))
    expect(value()).toBe('Asia/Tokyo')
    expect(document.activeElement).toBe(box())
  })

  it('says when nothing matches, and fixes the case of a typed name', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    await user.type(box(), 'atlantis')
    expect(screen.getByText('No time zone matches “atlantis”.')).toBeDefined()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    await user.clear(box())
    await user.type(box(), 'europe/paris')
    await user.tab()
    expect(value()).toBe('Europe/Paris')
  })
})

describe('matchTimeZones', () => {
  const zones = timeZoneNames()

  it('includes UTC', () => {
    expect(zones).toContain('UTC')
  })

  it.each([
    ['berlin', ['Europe/Berlin']],
    ['new_york', ['America/New_York']],
    ['europe ber', ['Europe/Berlin']],
    ['', zones],
  ])('matches %j', (query, expected) => {
    expect(matchTimeZones(zones, query)).toEqual(expected)
  })
})
