import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import * as time from '../public/time.ts'
import { matchTimeZones, TimeZoneName, TimeZonePicker, timeZoneNames } from './TimeZonePicker.tsx'

describe('the time zone name', () => {
  it.each(['Host time zone unavailable', ''])(
    'preserves a supplied label without the zone name: %j',
    (label) => {
      const { container } = render(
        <TimeZoneName name="Europe/Berlin" label={label} className="host-time-zone" />,
      )
      const name = container.querySelector('.host-time-zone')
      expect(name?.textContent).toBe(label)
      expect(name?.childElementCount).toBe(0)
    },
  )
})

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
  it('finds Chinese city aliases in the editable picker and retains the IANA value', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    await user.type(box(), '上海')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.click(screen.getByRole('option', { name: /Asia\/Shanghai/ }))
    expect(value()).toBe('Asia/Shanghai')
  })

  it('finds Chinese city aliases in the public picker alongside offset search', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <TimeZonePicker
        value="Europe/Berlin"
        onChange={onChange}
        now={Date.parse('2026-10-19T12:00Z')}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Time zone/ }))
    await user.type(screen.getByRole('combobox'), '纽约 GMT-04:00')
    await user.click(screen.getByRole('option', { name: /America\/New York/ }))
    expect(onChange).toHaveBeenCalledWith('America/New_York')
  })

  it.each(['editable', 'public'] as const)(
    'prefers city-name prefixes over substring matches in the %s picker',
    async (mode) => {
      const user = userEvent.setup()
      if (mode === 'editable') render(<Picker />)
      else {
        render(<TimeZonePicker value="UTC" onChange={vi.fn()} />)
        await user.click(screen.getByRole('button', { name: /Time zone/ }))
      }
      const search = screen.getByRole('combobox')
      for (const query of ['柏林', '柏']) {
        await user.clear(search)
        await user.type(search, query)
        expect(screen.getAllByRole('option')).toHaveLength(1)
        expect(screen.getByRole('option').textContent).toMatch(/^Europe\/Berlin/)
      }
      await user.clear(search)
      await user.type(search, '都柏')
      expect(screen.getAllByRole('option')).toHaveLength(1)
      expect(screen.getByRole('option').textContent).toMatch(/^Europe\/Dublin/)
      await user.clear(search)
      await user.type(search, '林')
      expect(
        screen.getAllByRole('option').map((option) => option.textContent?.split('GMT')[0]),
      ).toEqual(['Europe/Berlin', 'Europe/Dublin'])
    },
  )

  it.each([
    ['澳门', 'Asia/Macau'],
    ['乌鲁木齐', 'Asia/Urumqi'],
    ['胡志明市', 'Asia/Saigon'],
  ])('selects %s from the editable picker using its stored IANA value', async (query, id) => {
    const user = userEvent.setup()
    render(<Picker />)
    await user.type(box(), query)
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{Enter}')
    expect(value()).toBe(id)
  })

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
    // No inline override: the stylesheet's overflow-wrap fallback keeps wide segments inside
    // 320px options, while the <wbr> breaks are preferred wherever they fit.
    expect(current?.style.overflowWrap).toBe('')
    expect(current?.querySelectorAll('wbr')).toHaveLength(2)
    for (const br of current?.querySelectorAll('wbr') ?? [])
      expect(br.previousSibling?.textContent?.endsWith('/')).toBe(true)
    await user.click(screen.getByRole('button', { name: /Time zone/ }))
    await user.type(screen.getByRole('combobox'), 'Argentina La Rioja')
    const option = screen.getByRole('option')
    const name = option.firstElementChild as HTMLElement
    expect(name.textContent).toBe('America/Argentina/La Rioja')
    expect(name.style.overflowWrap).toBe('')
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
    ['上海', ['Asia/Shanghai']],
    ['北京', ['Asia/Shanghai']],
    ['洛杉矶', ['America/Los_Angeles']],
    ['纽约', ['America/New_York']],
    ['伦敦', ['Europe/London']],
    ['巴黎', ['Europe/Paris']],
    ['东京', ['Asia/Tokyo']],
    ['悉尼', ['Australia/Sydney']],
    ['柏林', ['Europe/Berlin']],
    ['柏', ['Europe/Berlin']],
    ['都柏林', ['Europe/Dublin']],
    ['都柏', ['Europe/Dublin']],
    ['林', ['Europe/Berlin', 'Europe/Dublin']],
    ['澳门', ['Asia/Macau']],
    ['澳門', ['Asia/Macau']],
    ['乌鲁木齐', ['Asia/Urumqi']],
    ['烏魯木齊', ['Asia/Urumqi']],
    ['胡志明市', ['Asia/Saigon']],
    ['西贡', ['Asia/Saigon']],
    ['利雅得', ['Asia/Riyadh']],
    ['德黑兰', ['Asia/Tehran']],
    ['卡拉奇', ['Asia/Karachi']],
    ['达卡', ['Asia/Dhaka']],
    ['布宜诺斯艾利斯', ['America/Buenos_Aires']],
    ['布达佩斯', ['Europe/Budapest']],
    ['哥本哈根', ['Europe/Copenhagen']],
    ['内罗毕', ['Africa/Nairobi']],
    ['阿克拉', ['Africa/Accra']],
    ['亚的斯亚贝巴', ['Africa/Addis_Ababa']],
    ['阿尔及尔', ['Africa/Algiers']],
    ['卡萨布兰卡', ['Africa/Casablanca']],
    ['拉各斯', ['Africa/Lagos']],
    ['突尼斯', ['Africa/Tunis']],
    ['波哥大', ['America/Bogota']],
    ['加拉加斯', ['America/Caracas']],
    ['利马', ['America/Lima']],
    ['圣地亚哥', ['America/Santiago']],
    ['阿拉木图', ['Asia/Almaty']],
    ['巴格达', ['Asia/Baghdad']],
    ['科伦坡', ['Asia/Colombo']],
    ['科威特', ['Asia/Kuwait']],
    ['塔什干', ['Asia/Tashkent']],
    ['仰光', ['Asia/Rangoon']],
    ['阿德莱德', ['Australia/Adelaide']],
    ['达尔文', ['Australia/Darwin']],
    ['霍巴特', ['Australia/Hobart']],
    ['布拉迪斯拉发', ['Europe/Bratislava']],
    ['布加勒斯特', ['Europe/Bucharest']],
    ['里加', ['Europe/Riga']],
    ['索非亚', ['Europe/Sofia']],
    ['斐济', ['Pacific/Fiji']],
    ['关岛', ['Pacific/Guam']],
    ['', zones],
  ])('matches %j', (query, expected) => {
    expect(matchTimeZones(zones, query)).toEqual(expected)
  })

  it('finds current IANA IDs when the browser uses them instead of legacy names', () => {
    expect(matchTimeZones(['Asia/Ho_Chi_Minh'], '胡志明市')).toEqual(['Asia/Ho_Chi_Minh'])
    expect(matchTimeZones(['America/Argentina/Buenos_Aires'], '布宜诺斯艾利斯')).toEqual([
      'America/Argentina/Buenos_Aires',
    ])
  })
})
