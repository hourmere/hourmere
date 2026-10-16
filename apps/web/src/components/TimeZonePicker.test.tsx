import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
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
