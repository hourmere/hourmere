import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { widgetMessages } from '../embed/language.ts'
import { fakeApi, json, renderApp } from '../test/fake-api.tsx'
import {
  booking,
  EVENT,
  eventRoutes,
  managed,
  slotsAnswer,
  TOKEN,
} from '../test/public-fixtures.ts'
import { selectPublicLanguage } from '../test/public-language.ts'
import { dateMessage, translateMessage } from './translate.ts'

vi.mock('../public/env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public/env.ts')>()),
  detectTimeZone: () => 'Europe/Berlin',
  preferredLocale: () => 'en-GB',
  now: () => Date.parse('2026-11-01T04:30:00Z'),
}))

const day = 'Montag, 2. November, verfügbar'

describe('German public booking language', () => {
  it('switches the booking calendar, time chips, form and confirmation and saves German', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...eventRoutes(EVENT, ['2026-11-02T14:00:00Z']),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, { booking: booking(), manageToken: TOKEN }),
    })
    renderApp('/ada/intro')
    await screen.findByRole('heading', { name: 'Intro call' })
    await selectPublicLanguage(user, 'de')
    expect(screen.getByRole('heading', { name: 'Zeit wählen' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeDefined()
    await user.click(await screen.findByRole('button', { name: day }))
    const times = screen.getByRole('list', { name: 'Zeiten am Montag, 2. November' })
    await user.click(within(times).getByRole('button', { name: '15:00' }))
    expect(screen.getByRole('heading', { name: 'Ihre Angaben' })).toBeDefined()
    await user.type(screen.getByLabelText('Ihr Name'), 'Synthetic Visitor')
    await user.type(
      screen.getByLabelText('E-Mail', { selector: 'input' }),
      'invitee@example.invalid',
    )
    await user.click(screen.getByRole('button', { name: 'Buchung bestätigen' }))
    await screen.findByRole('heading', { name: 'Ihr Termin ist gebucht' })
    expect(screen.getByRole('heading', { name: 'Zum Kalender hinzufügen' })).toBeDefined()
    expect(api.to('POST /api/v1/public/ada/intro/bookings')[0]?.body).toHaveProperty(
      'invitee.locale',
      'de',
    )
    expect(document.documentElement.lang).toBe('de')
    expect(document.documentElement.dir).toBe('ltr')
  })

  it.each(['de-AT', 'de-CH'])(
    'uses German dates and controls for browser language %s',
    async (regional) => {
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue([regional])
      fakeApi(eventRoutes(EVENT, ['2026-11-02T14:00:00Z']))
      renderApp('/ada/intro')
      expect(await screen.findByRole('button', { name: day })).toBeDefined()
      expect(screen.getByRole('button', { name: /Deutsch/ }).textContent).toContain('Deutsch')
      expect(translateMessage('de', dateMessage('2026-11-02'))).toBe(
        new Intl.DateTimeFormat('de-DE', {
          calendar: 'gregory',
          timeZone: 'UTC',
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }).format(new Date('2026-11-02T00:00:00Z')),
      )
    },
  )

  it('uses the reviewed Google and time-zone wording', () => {
    expect(translateMessage('de', 'Join Google Meet')).toBe('Mit Google Meet teilnehmen')
    expect(
      translateMessage(
        'de',
        'Your time is reserved. The Google Meet link and final calendar invitation are being prepared.',
      ),
    ).toContain('Google-Meet-Link')
    expect(translateMessage('de', 'Create a unique Google Meet link for each booking')).toContain(
      'Google-Meet-Link',
    )
    expect(
      translateMessage(
        'de',
        'The host needs to reconnect the original Google Calendar account before retrying.',
      ),
    ).toContain('Google-Calendar-Konto')
    expect(translateMessage('de', 'Search by city or offset')).toBe(
      'Nach Stadt oder UTC-Abweichung suchen',
    )
  })

  it('distinguishes the previous and new booking times in the move confirmation', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de'])
    fakeApi({
      'GET /api/v1/bookings/manage': () => json(200, managed()),
      'GET /api/v1/bookings/manage/slots': slotsAnswer(['2026-11-03T15:00:00Z']),
    })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    await user.click(
      await screen.findByRole('button', { name: 'Dienstag, 3. November, verfügbar' }),
    )
    await user.click(
      within(screen.getByRole('list', { name: 'Zeiten am Dienstag, 3. November' })).getByRole(
        'button',
      ),
    )
    expect(screen.getByRole('heading', { name: 'Ihre Buchung verschieben?' })).toBeDefined()
    const previous = screen.getByText('Bisher', { selector: 'dt' })
    const next = screen.getByText('Neu', { selector: 'dt' })
    expect(previous.nextElementSibling?.textContent).toContain('Montag, 2. November 2026')
    expect(next.nextElementSibling?.textContent).toContain('Dienstag, 3. November 2026')
    expect(screen.queryByText('Von', { selector: 'dt' })).toBeNull()
    expect(screen.queryByText('Auf', { selector: 'dt' })).toBeNull()
  })

  it('translates private booking management and embedded widget controls', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de'])
    fakeApi({
      'GET /api/v1/bookings/manage': () => json(200, managed()),
    })
    renderApp(`/booking#token=${TOKEN}`)
    expect(await screen.findByRole('button', { name: 'Buchung stornieren' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Verschieben' })).toBeDefined()
    expect(widgetMessages('de')).toEqual({
      iframe: 'Termin mit Hourmere buchen',
      title: 'Termin buchen',
      close: 'Schließen',
      closeLabel: 'Buchungsfenster schließen',
      failure:
        'Das Buchungswidget konnte nicht geladen werden. Prüfen Sie die Hourmere-URL und die Einbettungseinstellungen der Instanz.',
    })
  })
})
