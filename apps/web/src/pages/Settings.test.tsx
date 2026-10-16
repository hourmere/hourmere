import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { fakeApi, json, later, PROFILE, profile, renderApp, signedIn } from '../test/fake-api.tsx'
import { LEAVE_WITH_UNSAVED_CHANGES } from '../unsaved-changes.tsx'
import { suggestHandle } from './Settings.tsx'

const input = (name: string) => screen.getByLabelText<HTMLInputElement>(name)
const zone = () => screen.getByRole<HTMLInputElement>('combobox', { name: 'Time zone' })

function profileServer(
  current: Schemas['Profile'] | null,
  put: (call: { body: unknown }) => Response | Promise<Response> = defaultPut,
) {
  return fakeApi({ ...signedIn, ...profile(current), 'PUT /api/v1/profile': put })
}

function defaultPut({ body }: { body: unknown }) {
  return json(200, { ...PROFILE, ...(body as object) })
}

async function chooseZone(name: string) {
  const user = userEvent.setup()
  await user.clear(zone())
  await user.type(zone(), name)
  await user.keyboard('{Enter}')
}

describe('the profile settings', () => {
  it('suggests a profile to people without one, and creates it', async () => {
    const user = userEvent.setup()
    const api = profileServer(null, ({ body }) => json(201, { ...PROFILE, ...(body as object) }))
    renderApp('/app/settings')
    expect(await screen.findByText(/Choose a handle to get booking links/)).toBeDefined()
    // From the email address ada@example.com.
    expect(input('Handle').value).toBe('ada')
    expect(screen.getByText(`${window.location.origin}/ada/`)).toBeDefined()
    await chooseZone('lisbon')
    await user.clear(input('Language'))
    await user.type(input('Language'), 'pt-br')
    expect(screen.getByText(/: Brazilian Portuguese|: Portuguese \(Brazil\)/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Create profile' }))

    const status = await screen.findByText('Profile created. Your booking links are ready.')
    expect(document.activeElement).toBe(status)
    expect(api.to('PUT /api/v1/profile').map((c) => c.body)).toEqual([
      { handle: 'ada', timeZone: 'Europe/Lisbon', locale: 'pt-BR' },
    ])
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDefined()
  })

  it('saves a changed handle, warning that shared links stop working', async () => {
    const user = userEvent.setup()
    const api = profileServer(PROFILE)
    renderApp('/app/settings')
    await screen.findByDisplayValue('ada')
    expect(zone().value).toBe('Europe/Berlin')
    expect(screen.queryByText(/will stop working/)).toBeNull()
    await user.clear(input('Handle'))
    await user.type(input('Handle'), 'ada-l')
    expect(screen.getByText(/Links you have already shared will stop working\./)).toBeDefined()
    expect(screen.getByText('Unsaved changes')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(await screen.findByText('Saved.')).toBeDefined()
    expect(api.to('PUT /api/v1/profile')[0]?.body).toEqual({
      handle: 'ada-l',
      timeZone: 'Europe/Berlin',
      locale: 'en',
    })
    expect(screen.queryByText(/will stop working/)).toBeNull()
  })

  it.each([
    [
      json(400, { error: 'handle_reserved', message: 'This handle is reserved' }),
      'Handle',
      'This handle is reserved. Choose another one.',
    ],
    [
      json(409, { error: 'handle_taken', message: 'This handle is already taken' }),
      'Handle',
      'This handle is already taken. Choose another one.',
    ],
    [
      json(400, { error: 'invalid_handle', message: 'handle must be …' }),
      'Handle',
      'Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.',
    ],
    [
      json(400, { error: 'invalid_time_zone', message: 'timeZone is not a known IANA time zone' }),
      'Time zone',
      'This is not a time zone the server knows. Choose one from the list.',
    ],
    [
      json(400, { error: 'invalid_locale', message: 'locale must be a BCP 47 language tag' }),
      'Language',
      'Enter a language tag such as en, en-GB or pt-BR.',
    ],
  ])('shows the server refusing it at the field (%#)', async (response, label, message) => {
    const user = userEvent.setup()
    profileServer(PROFILE, () => response)
    renderApp('/app/settings')
    await screen.findByDisplayValue('ada')
    await user.clear(input('Handle'))
    await user.type(input('Handle'), 'admin')
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    const summary = await screen.findByRole('alert')
    expect(within(summary).getByRole('link').textContent).toBe(`${label}: ${message}`)
    const control = screen.getByLabelText(label)
    expect(control.getAttribute('aria-invalid')).toBe('true')
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('checks the handle, time zone and language before sending', async () => {
    const user = userEvent.setup()
    const api = profileServer(PROFILE)
    renderApp('/app/settings')
    await screen.findByDisplayValue('ada')
    await user.clear(input('Handle'))
    await user.type(input('Handle'), 'Ada Lovelace')
    await chooseZone('Nowhere/Land')
    await user.clear(input('Language'))
    await user.type(input('Language'), 'not a language')
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    const summary = await screen.findByRole('alert')
    expect(
      within(summary)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual([
      'Handle: Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.',
      'Time zone: Choose a time zone from the list, e.g. Europe/Berlin.',
      'Language: Enter a language tag such as en, en-GB or pt-BR.',
    ])
    expect(api.to('PUT /api/v1/profile')).toHaveLength(0)
  })

  it('shows the account, which comes from signing in', async () => {
    profileServer(PROFILE)
    renderApp('/app/settings')
    const account = await screen.findByRole('region', { name: 'Account' })
    expect(account.textContent).toContain('ada@example.com')
    expect(account.textContent).toContain('Ada (personal)')
  })
})

describe('unsaved profile changes', () => {
  const leaving = () => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('are protected before the first save', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const api = fakeApi({
      ...signedIn,
      ...profile(null),
      'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
      'POST /api/auth/sign-out': () => json(200, { success: true }),
    })
    renderApp('/app/settings')
    await screen.findByText(/Choose a handle to get booking links/)
    // The suggestions alone are nothing to lose.
    expect(leaving()).toBe(false)
    await user.click(screen.getByRole('link', { name: 'Bookings' }))
    await screen.findByText('No upcoming bookings.')
    expect(confirm).not.toHaveBeenCalled()
    await user.click(screen.getByRole('link', { name: 'Settings' }))

    await user.clear(await screen.findByLabelText('Handle'))
    await user.type(input('Handle'), 'ada-lovelace')
    expect(screen.getByText('Unsaved changes')).toBeDefined()
    expect(leaving()).toBe(true)
    await user.click(screen.getByRole('link', { name: 'Bookings' }))
    expect(confirm).toHaveBeenCalledWith(LEAVE_WITH_UNSAVED_CHANGES)
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(api.to('POST /api/auth/sign-out')).toHaveLength(0)
    expect(input('Handle').value).toBe('ada-lovelace')
  })

  it('are still protected after a failed create', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    profileServer(null, () => json(500, { error: 'internal_error' }))
    renderApp('/app/settings')
    await user.clear(await screen.findByLabelText('Handle'))
    await user.type(input('Handle'), 'ada-lovelace')
    await user.click(screen.getByRole('button', { name: 'Create profile' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save your profile.')
    expect(leaving()).toBe(true)
    await user.click(screen.getByRole('link', { name: 'Bookings' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('location').textContent).toBe('/app/settings')
  })

  it('are locked while saving, so none is overwritten', async () => {
    const user = userEvent.setup()
    const save = later()
    profileServer(PROFILE, () => save.response)
    renderApp('/app/settings')
    await screen.findByDisplayValue('ada')
    await user.type(input('Handle'), '-l')
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(document.activeElement?.textContent).toBe('Saving…')
    expect(input('Handle').matches(':disabled')).toBe(true)
    await user.type(input('Handle'), 'x')
    expect(input('Handle').value).toBe('ada-l')
    await save.answer(json(200, { ...PROFILE, handle: 'ada-l' }))
    expect(screen.getByText('Saved.')).toBeDefined()
    expect(input('Handle').matches(':disabled')).toBe(false)
    expect(screen.queryByText('Unsaved changes')).toBeNull()
  })
})

describe('suggestHandle', () => {
  it.each([
    ['ada@example.com', 'ada'],
    ['Ada.Lovelace+cal@example.com', 'ada-lovelace-cal'],
    ['__x__@example.com', 'x'],
    [`${'a'.repeat(39)}.b@example.com`, 'a'.repeat(39)],
    ['@example.com', ''],
  ])('%s → %s', (email, handle) => {
    expect(suggestHandle(email)).toBe(handle)
  })
})
