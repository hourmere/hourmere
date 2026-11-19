import '../../i18n/admin.ts'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import { RULES } from '../../limits.ts'
import { TimeUnitField } from './TimeUnitField.tsx'

type TimingField =
  | 'minimumNoticeMinutes'
  | 'bufferBeforeMinutes'
  | 'bufferAfterMinutes'
  | 'bookingWindowDays'
function Harness({ field, initial }: { field: TimingField; initial: string }) {
  const [value, setValue] = useState(initial)
  const [changes, setChanges] = useState(0)
  const valid =
    value === ''
      ? field === 'bookingWindowDays'
      : /^\d+$/.test(value) &&
        Number(value) >= RULES[field].min &&
        Number(value) <= RULES[field].max
  return (
    <>
      <TimeUnitField
        id={field}
        label={field}
        value={value}
        onChange={(next) => {
          setValue(next)
          setChanges((count) => count + 1)
        }}
        rule={RULES[field]}
        storageUnit={field === 'bookingWindowDays' ? 'days' : 'minutes'}
        optional={field === 'bookingWindowDays'}
        error={valid ? undefined : 'Enter a whole number.'}
      />
      <output data-testid="stored">{value}</output>
      <output data-testid="changes">{changes}</output>
    </>
  )
}

describe.each([
  {
    field: 'minimumNoticeMinutes',
    values: ['0', '525600', '1', '90', '1441', '60'],
    initialUnits: ['minutes', 'days', 'minutes', 'minutes', 'minutes', 'hours'],
  },
  {
    field: 'bufferBeforeMinutes',
    values: ['0', '1440', '1', '90', '1439', '60'],
    initialUnits: ['minutes', 'days', 'minutes', 'minutes', 'minutes', 'hours'],
  },
  {
    field: 'bufferAfterMinutes',
    values: ['0', '1440', '1', '90', '1439', '60'],
    initialUnits: ['minutes', 'days', 'minutes', 'minutes', 'minutes', 'hours'],
  },
  {
    field: 'bookingWindowDays',
    values: ['1', '3650', '61', '1441', ''],
    initialUnits: ['days', 'days', 'days', 'days', 'days'],
  },
] as const)('$field lossless units', ({ field, values, initialUnits }) => {
  it.each(values.map((value, index) => ({ value, initialUnit: initialUnits[index] })))(
    'round trips stored $value through every unit without editing canonical state',
    async ({ value, initialUnit }) => {
      chooseLanguage('en')
      render(<Harness field={field} initial={value} />)
      const user = userEvent.setup()
      const input = screen.getByLabelText<HTMLInputElement>(field, {
        exact: false,
        selector: 'input',
      })
      const selector = screen.getByRole<HTMLSelectElement>('combobox', { name: `${field} unit` })
      expect(selector.value).toBe(initialUnit)
      for (const unit of ['minutes', 'hours', 'days', initialUnit as string]) {
        await user.selectOptions(selector, unit)
        expect(screen.getByTestId('stored').textContent).toBe(value)
        expect(screen.getByTestId('changes').textContent).toBe('0')
        expect(input.getAttribute('aria-invalid')).toBeNull()
      }
      const storageUnit = field === 'bookingWindowDays' ? 'days' : 'minutes'
      await user.selectOptions(selector, storageUnit)
      expect(input.value).toBe(value)
      // Editing the exact original stored number after a presentation round-trip is stable too.
      fireEvent.change(input, { target: { value: value === '' ? '1' : value === '1' ? '2' : '1' } })
      fireEvent.change(input, { target: { value } })
      expect(screen.getByTestId('stored').textContent).toBe(value)
    },
  )

  it('converts edits, allows whole storage units and exposes chosen-unit range errors', async () => {
    chooseLanguage('en')
    render(<Harness field={field} initial="1" />)
    const user = userEvent.setup()
    const input = screen.getByLabelText<HTMLInputElement>(field, {
      exact: false,
      selector: 'input',
    })
    const selector = screen.getByRole('combobox', { name: `${field} unit` })
    await user.selectOptions(selector, 'hours')
    fireEvent.change(input, { target: { value: field === 'bookingWindowDays' ? '48' : '1.5' } })
    expect(screen.getByTestId('stored').textContent).toBe(
      field === 'bookingWindowDays' ? '2' : '90',
    )
    expect(input.getAttribute('aria-invalid')).toBeNull()
    fireEvent.change(input, { target: { value: '0.001' } })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toContain(`${field}-error`)
    expect(document.getElementById(`${field}-error`)?.textContent).toContain('hours')
    fireEvent.change(input, {
      target: {
        value: String((RULES[field].max + 1) * (field === 'bookingWindowDays' ? 24 : 1 / 60)),
      },
    })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    await user.selectOptions(selector, 'days')
    expect(document.getElementById(`${field}-error`)?.textContent).toContain('days')
  })
})

it('names units and validation in Chinese with full-width punctuation', async () => {
  chooseLanguage('zh-CN')
  render(
    <TimeUnitField
      id="notice"
      label="最短提前通知"
      value="invalid"
      onChange={() => {}}
      rule={{ min: 0, max: 525600 }}
      error="Enter a whole number."
    />,
  )
  const user = userEvent.setup()
  const selector = screen.getByRole('combobox', { name: /最短提前通知/ })
  expect(screen.getByRole('option', { name: '分钟' })).toBeTruthy()
  expect(screen.getByRole('option', { name: '小时' })).toBeTruthy()
  expect(screen.getByRole('option', { name: '天' })).toBeTruthy()
  await user.selectOptions(selector, 'hours')
  expect(document.getElementById('notice-error')?.textContent).toContain('小时')
  expect(document.getElementById('notice-error')?.textContent).toContain('。')
})

it.each([
  { field: 'minimumNoticeMinutes', stored: '111', unit: 'hours', shown: '1.85' },
  { field: 'bufferBeforeMinutes', stored: '63', unit: 'days', shown: '0.04375' },
  { field: 'minimumNoticeMinutes', stored: '90', unit: 'hours', shown: '1.5' },
] as const)(
  'shows $stored stored minutes as exactly $shown $unit',
  async ({ field, stored, unit, shown }) => {
    chooseLanguage('en')
    render(<Harness field={field} initial={stored} />)
    const user = userEvent.setup()
    await user.selectOptions(screen.getByRole('combobox', { name: `${field} unit` }), unit)
    const input = screen.getByLabelText<HTMLInputElement>(field, {
      exact: false,
      selector: 'input',
    })
    // A precomputed 1/60 or 1/1440 factor leaves float noise such as 1.8499999999999999.
    expect(input.value).toBe(shown)
    expect(screen.getByTestId('stored').textContent).toBe(stored)
    expect(screen.getByTestId('changes').textContent).toBe('0')
  },
)

describe.each(['en', 'zh-CN'] as const)('time field feedback in %s', (language) => {
  it('keeps invalid text visible through unit changes and shows no converted value', async () => {
    chooseLanguage(language)
    render(<Harness field="minimumNoticeMinutes" initial="60" />)
    const user = userEvent.setup()
    const input = document.getElementById('minimumNoticeMinutes') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'not a number' } })
    const selector = screen.getByRole('combobox')
    for (const unit of ['days', 'minutes', 'hours']) {
      await user.selectOptions(selector, unit)
      expect(input.value).toBe('not a number')
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(screen.getByTestId('stored').textContent).toBe('invalid')
      expect(document.getElementById('minimumNoticeMinutes-hint')?.textContent).not.toMatch(
        /Current value|当前值|NaN/,
      )
    }
  })

  it('labels the current draft and joins Chinese sentences without half-width spaces', () => {
    chooseLanguage(language)
    render(<Harness field="bookingWindowDays" initial="30" />)
    const input = document.getElementById('bookingWindowDays') as HTMLInputElement
    fireEvent.change(input, { target: { value: '60' } })
    const hint = document.getElementById('bookingWindowDays-hint')?.textContent
    expect(hint).toContain(language === 'en' ? 'Current value: 60 days.' : '当前值：60 天。')
    expect(hint).not.toMatch(/Stored value|存储值|。 /)
    if (language === 'en') expect(hint).toContain('Enter 1–3650 days, in whole days.')
  })
})
