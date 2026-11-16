import '../../i18n/admin.ts'
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { emptyDraft, toInput } from './event-type-form.ts'
import { OrderedLocationsEditor } from './OrderedLocationsEditor.tsx'

function Harness({ phone = false, unset = false }: { phone?: boolean; unset?: boolean }) {
  const [draft, setDraft] = useState({
    ...emptyDraft(),
    locationKind: unset ? ('' as const) : phone ? ('phone' as const) : ('google_meet' as const),
    phone: phone ? '+14155550123' : '',
  })
  return (
    <InterfaceScope surface="admin">
      <OrderedLocationsEditor
        draft={draft}
        errors={{}}
        set={(name, value) => setDraft((previous) => ({ ...previous, [name]: value }))}
      />
      <output data-testid="body">{JSON.stringify(toInput(draft))}</output>
    </InterfaceScope>
  )
}

describe('ordered location options', () => {
  it('adds, labels, edits, reorders and removes an option without losing the primary choice', () => {
    render(<Harness />)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Default location' }).checked).toBe(
      true,
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Add location option' }), {
      target: { value: 'in_person' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add location option' }))
    const office = screen.getByRole('group', { name: 'In person' })
    fireEvent.change(within(office).getByLabelText('Location label (optional)'), {
      target: { value: 'Office' },
    })
    fireEvent.change(within(office).getByLabelText('Address'), {
      target: { value: '42 Main Street' },
    })
    fireEvent.click(within(office).getByRole('button', { name: 'Move location up' }))
    const body = JSON.parse(screen.getByTestId('body').textContent ?? '{}')
    expect(body.locations).toEqual([
      { id: expect.any(String), kind: 'in_person', label: 'Office', address: '42 Main Street' },
      { id: 'primary', kind: 'google_meet', isDefault: true },
    ])
    expect(body).not.toHaveProperty('location')
    expect(
      within(office).getByRole<HTMLInputElement>('radio', { name: 'Default location' }).checked,
    ).toBe(false)
    expect(document.activeElement).toBe(within(office).getByLabelText('Location label (optional)'))
    fireEvent.click(
      screen.getAllByRole('radio', { name: 'Default location' })[1] as HTMLInputElement,
    )
    expect(
      within(office).getByRole<HTMLInputElement>('radio', { name: 'Default location' }).checked,
    ).toBe(false)
    fireEvent.click(within(office).getByRole('radio', { name: 'Default location' }))
    expect(JSON.parse(screen.getByTestId('body').textContent ?? '{}').locations[0].isDefault).toBe(
      true,
    )
    fireEvent.click(within(office).getByRole('button', { name: 'Move location down' }))
    expect(document.activeElement).toBe(within(office).getByLabelText('Location label (optional)'))
    fireEvent.click(within(office).getByRole('button', { name: 'Remove location option' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Location label (optional)'))
    expect(JSON.parse(screen.getByTestId('body').textContent ?? '{}').locations).toEqual([
      { id: 'primary', kind: 'google_meet' },
    ])
  })
  it('switches the primary phone between host and invitee modes', () => {
    render(<Harness phone />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Invitee provides a phone number' }))
    expect(JSON.parse(screen.getByTestId('body').textContent ?? '{}').locations).toEqual([
      {
        id: 'primary',
        kind: 'phone',
        askInvitee: true,
      },
    ])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Invitee provides a phone number' }))
    expect(JSON.parse(screen.getByTestId('body').textContent ?? '{}').location).toEqual({
      kind: 'phone',
      number: '',
    })
  })
  it('detects removing the implicit first-option default from a source copy', () => {
    const source = readFileSync('apps/web/src/pages/event-types/OrderedLocationsEditor.tsx', 'utf8')
    const expression = source.match(/const defaultId = (.*)/)?.[1]
    expect(expression).toBeDefined()
    const check = (code: string) => {
      const effectiveDefault = new Function('options', `return ${code}`)
      expect(effectiveDefault([{ id: 'first' }, { id: 'second' }])).toBe('first')
      expect(effectiveDefault([{ id: 'second' }, { id: 'first' }])).toBe('second')
      expect(effectiveDefault([{ id: 'first' }, { id: 'second', isDefault: true }])).toBe('second')
    }
    check(expression as string)
    expect(() => check((expression as string).replace(' ?? options[0]', ''))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    check(expression as string)
  })
})

it('detects losing focus or changing the implicit default while moving source-copy options', () => {
  const source = readFileSync('apps/web/src/pages/event-types/OrderedLocationsEditor.tsx', 'utf8')
  const move = source.slice(source.indexOf('  function move('), source.indexOf('  function add('))
  const check = (code: string) => {
    const input = document.createElement('input')
    input.id = 'location-option-second-label'
    document.body.append(input)
    let result: unknown
    const pendingFocus = { current: null }
    try {
      new Function(
        'options',
        'defaultId',
        'set',
        'pendingFocus',
        `${code.replace('index: number, direction: number', 'index, direction').replace(' as const', '')}; move(1, -1)`,
      )(
        [{ id: 'first' }, { id: 'second' }],
        'first',
        (_key: string, value: unknown) => {
          result = value
        },
        pendingFocus,
      )
      if (pendingFocus.current) document.getElementById(pendingFocus.current)?.focus()
      expect(document.activeElement).toBe(input)
      expect(result).toEqual([{ id: 'second' }, { id: 'first', isDefault: true }])
    } finally {
      input.remove()
    }
  }
  check(move)
  for (const mutant of [
    move.replace(/pendingFocus.current = `location-option-.*-label`/, ''),
    move.replace('item.id === defaultId ? { ...item, isDefault: true as const } : item', 'item'),
  ])
    expect(() => check(mutant)).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
  check(move)
})

it('detects losing focus when removing a source-copy option', () => {
  const source = readFileSync('apps/web/src/pages/event-types/OrderedLocationsEditor.tsx', 'utf8')
  const start = source.indexOf('                    const neighbor =')
  const handler = source.slice(start, source.indexOf('\n                  }}', start))
  const check = (code: string, sole = false) => {
    const input = document.createElement('input')
    input.id = sole ? 'location-option-add-kind' : 'location-option-first-label'
    document.body.append(input)
    const pendingFocus = { current: null }
    try {
      new Function('options', 'index', 'option', 'set', 'pendingFocus', code)(
        sole ? [{ id: 'second' }] : [{ id: 'first' }, { id: 'second' }],
        sole ? 0 : 1,
        { id: 'second' },
        () => {},
        pendingFocus,
      )
      if (pendingFocus.current) document.getElementById(pendingFocus.current)?.focus()
      expect(document.activeElement).toBe(input)
    } finally {
      input.remove()
    }
  }
  check(handler)
  expect(() =>
    check(handler.replace('pendingFocus.current = neighbor', 'void neighbor')),
  ).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
  check(handler, true)
  expect(() =>
    check(handler.replace("'location-option-add-kind'", "'missing-control'"), true),
  ).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
  check(handler)
})

it('returns focus to adding a choice after removing the only additional option', () => {
  render(<Harness unset />)
  fireEvent.click(screen.getByRole('button', { name: 'Add location option' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove location option' }))
  expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Add location option' }))
})

it('detects dropping post-commit focus from the source-copy layout effect', () => {
  const source = readFileSync('apps/web/src/pages/event-types/OrderedLocationsEditor.tsx', 'utf8')
  const start = source.indexOf('  useLayoutEffect(() => {')
  const effect = source.slice(start, source.indexOf('\n  const options', start))
  const check = (code: string) => {
    const input = document.createElement('input')
    input.id = 'pending-focus-control'
    document.body.append(input)
    try {
      new Function('useLayoutEffect', 'pendingFocus', code)((callback: () => void) => callback(), {
        current: input.id,
      })
      expect(document.activeElement).toBe(input)
    } finally {
      input.remove()
    }
  }
  check(effect)
  expect(() => check(effect.replace('?.focus()', ''))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  check(effect)
})
