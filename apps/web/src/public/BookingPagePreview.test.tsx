import { brandPalette } from '@hourmere/core/brand-contrast'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { chooseLanguage, languageChoice } from '../i18n/store.ts'
import { EVENT } from '../test/public-fixtures.ts'
import type { PublicEventType } from './api.ts'
import { BookingPagePreview } from './BookingPagePreview.tsx'

vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  detectTimeZone: () => 'America/New_York',
  preferredLocale: () => 'en-US',
  now: () => Date.parse('2026-11-01T04:30:00Z'),
}))

const NOTICE = 'These are sample times. Booking is disabled in the preview.'
const BRANDING = {
  name: 'Example organization',
  primaryColor: '#5c248a',
  logoDataUrl: null,
  logoUrl: `/api/v1/public/branding/example/logo/${'a'.repeat(64)}`,
}

it('shows live draft changes and sample times without sending requests or persisting data', async () => {
  chooseLanguage('en')
  const user = userEvent.setup()
  const fetch = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const writeStorage = vi.spyOn(Storage.prototype, 'setItem')
  const writeCookie = vi.spyOn(Document.prototype, 'cookie', 'set')
  const { container, rerender } = render(<BookingPagePreview event={EVENT} />)
  expect(screen.getByRole('heading', { name: 'Intro call' })).toHaveProperty('tagName', 'H2')
  expect(screen.getByText(NOTICE)).toBeTruthy()
  expect(screen.getByRole('grid')).toBeTruthy()

  const event = {
    ...EVENT,
    title: 'Draft consultation',
    description: 'An unsaved description.',
    durationMinutes: 45,
    allowedDurationsMinutes: [30, 45, 60],
    locations: [{ id: 'online', kind: 'google_meet', isDefault: true }],
    branding: BRANDING,
  } satisfies PublicEventType
  rerender(<BookingPagePreview event={event} logoSrc="https://example.invalid/tracking.png" />)
  expect(screen.getByRole('heading', { name: event.title })).toBeTruthy()
  expect(screen.getByText(event.description)).toBeTruthy()
  expect(screen.getByText('Google Meet')).toBeTruthy()
  expect(screen.getByRole('radio', { name: '45 min', checked: true })).toBeTruthy()
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('.public-preview')).toHaveProperty('lang', 'en')
  const palette = brandPalette(BRANDING.primaryColor)
  const style = container.querySelector<HTMLElement>('.public-preview')?.style
  expect(style?.getPropertyValue('--brand-light-accent')).toBe(palette?.light.accent)
  expect(style?.getPropertyValue('--brand-dark-accent')).toBe(palette?.dark.accent)

  await user.click(screen.getByRole('radio', { name: '1 h' }))
  await user.click(await screen.findByRole('button', { name: '9:00 AM' }))
  expect(screen.getByRole('heading', { name: 'Your details' })).toBeTruthy()

  const question = {
    id: 'draft',
    label: 'What is your topic?',
    type: 'short_text',
    required: true,
  } as const
  rerender(<BookingPagePreview event={{ ...event, questions: [question] }} />)
  await user.type(screen.getByLabelText(question.label), 'Example answer')
  expect(screen.getByLabelText(question.label)).toHaveProperty('value', 'Example answer')
  await user.type(screen.getByLabelText('Your name'), 'Sample invitee')
  await user.type(screen.getByLabelText('Email'), 'sample@example.invalid')
  const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm booking' })
  expect(confirm.disabled).toBe(true)
  expect(confirm.getAttribute('aria-describedby')).toBe(screen.getByText(NOTICE).id)
  await user.click(confirm)
  if (!confirm.form) throw new Error('Expected shared booking form')
  expect(fireEvent.submit(confirm.form)).toBe(false)

  await user.click(screen.getByRole('button', { name: 'Change time' }))
  const trigger = screen.getByRole('button', { name: /Time zone/i })
  await user.click(trigger)
  await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: /UTC/ }))
  expect(trigger.textContent).toContain('UTC')
  expect(fetch).not.toHaveBeenCalled()
  expect(writeStorage).not.toHaveBeenCalled()
  expect(writeCookie).not.toHaveBeenCalled()
})

it('uses the public language preference, scopes language changes and displays preloaded branding', async () => {
  chooseLanguage('de')
  const originalLanguage = document.documentElement.lang
  const originalDirection = document.documentElement.dir
  const fetch = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const writeStorage = vi.spyOn(Storage.prototype, 'setItem')
  const writeCookie = vi.spyOn(Document.prototype, 'cookie', 'set')
  const user = userEvent.setup()
  const logoSrc = 'data:image/png;base64,AAAA'
  const { container } = render(
    <BookingPagePreview event={{ ...EVENT, title: '', branding: BRANDING }} logoSrc={logoSrc} />,
  )
  const preview = container.querySelector('.public-preview')
  expect(preview).toHaveProperty('lang', 'de')
  expect(preview).toHaveProperty('dir', 'ltr')
  expect(screen.getByRole('heading', { name: 'Zeit wählen' })).toBeTruthy()
  expect(screen.getByRole('img', { name: BRANDING.name }).getAttribute('src')).toBe(logoSrc)
  await user.click(screen.getByRole('button', { name: 'Sprache: Deutsch' }))
  await user.click(screen.getByRole('menuitemradio', { name: 'Français' }))
  expect(preview).toHaveProperty('lang', 'fr')
  expect(screen.getByRole('heading', { name: 'Choisissez un horaire' })).toBeTruthy()
  expect(
    screen.getByText(
      'Ces horaires sont donnés à titre d’exemple. Les réservations sont désactivées dans l’aperçu.',
    ),
  ).toBeTruthy()
  expect(document.documentElement.lang).toBe(originalLanguage)
  expect(document.documentElement.dir).toBe(originalDirection)
  expect(languageChoice()).toBe('de')
  expect(writeStorage).not.toHaveBeenCalled()
  expect(writeCookie).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('follows changes to the shared language preference until the preview language is chosen', async () => {
  chooseLanguage('en')
  const user = userEvent.setup()
  const { container } = render(<BookingPagePreview event={EVENT} />)
  const preview = container.querySelector('.public-preview')
  expect(preview).toHaveProperty('lang', 'en')
  act(() => chooseLanguage('de'))
  expect(preview).toHaveProperty('lang', 'de')
  await user.click(screen.getByRole('button', { name: 'Sprache: Deutsch' }))
  await user.click(screen.getByRole('menuitemradio', { name: 'Français' }))
  act(() => chooseLanguage('zh-CN'))
  expect(preview).toHaveProperty('lang', 'fr')
})

it('shows the new draft default when the host changes it after a sample location was picked', async () => {
  chooseLanguage('en')
  const user = userEvent.setup()
  const event = {
    ...EVENT,
    locations: [
      { id: 'phone', kind: 'phone', isDefault: true },
      { id: 'zoom', kind: 'zoom' },
      { id: 'meet', kind: 'google_meet' },
    ],
  } satisfies PublicEventType
  const { rerender } = render(<BookingPagePreview event={event} />)
  const about = screen.getByRole('complementary', { name: 'About this event' })
  expect(within(about).getByText('Phone call')).toBeTruthy()
  await user.click(screen.getByRole('radio', { name: 'Zoom' }))
  expect(within(about).getByText('Zoom')).toBeTruthy()

  rerender(
    <BookingPagePreview
      event={{
        ...event,
        locations: [
          { id: 'phone', kind: 'phone' },
          { id: 'zoom', kind: 'zoom' },
          { id: 'meet', kind: 'google_meet', isDefault: true },
        ],
      }}
    />,
  )
  expect(screen.getByRole('radio', { name: 'Google Meet', checked: true })).toBeTruthy()
  expect(within(about).getByText('Google Meet')).toBeTruthy()
})
