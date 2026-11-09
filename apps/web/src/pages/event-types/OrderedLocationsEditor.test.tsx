import '../../i18n/admin.ts'
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { emptyDraft, toInput } from './event-type-form.ts'
import { OrderedLocationsEditor } from './OrderedLocationsEditor.tsx'

function Harness({ phone = false }: { phone?: boolean }) {
  const [draft, setDraft] = useState({
    ...emptyDraft(),
    locationKind: phone ? ('phone' as const) : ('google_meet' as const),
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
      { id: 'primary', kind: 'google_meet' },
    ])
    expect(body).not.toHaveProperty('location')
    expect(
      within(office).getByRole<HTMLInputElement>('radio', { name: 'Default location' }).checked,
    ).toBe(true)
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
    fireEvent.click(within(office).getByRole('button', { name: 'Remove location option' }))
    expect(JSON.parse(screen.getByTestId('body').textContent ?? '{}').locations).toEqual([
      { id: 'primary', kind: 'google_meet' },
    ])
  })
  it('switches the primary phone between host and invitee modes', () => {
    render(<Harness phone />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Invitee provides a phone number' }))
    expect(JSON.parse(screen.getByTestId('body').textContent ?? '{}').location).toEqual({
      kind: 'phone',
      askInvitee: true,
    })
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
