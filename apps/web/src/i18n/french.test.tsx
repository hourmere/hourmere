import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { widgetMessages } from '../embed/language.ts'
import { fakeApi, json, PROFILE, profile, renderApp, signedIn } from '../test/fake-api.tsx'
import {
  booking,
  EVENT,
  eventRoutes,
  managed,
  slotsAnswer,
  TOKEN,
} from '../test/public-fixtures.ts'
import { chooseLanguage } from './store.ts'
import { dateMessage, msg, translateMessage } from './translate.ts'

vi.mock('../public/env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public/env.ts')>()),
  detectTimeZone: () => 'Europe/Paris',
  preferredLocale: () => 'en-GB',
  now: () => Date.parse('2026-11-01T04:30:00Z'),
}))

const day = 'lundi 2 novembre, disponible'

async function completeBooking(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: day }))
  const times = screen.getByRole('list', { name: 'Horaires du lundi 2 novembre' })
  await user.click(within(times).getByRole('button', { name: '15:00' }))
  expect(screen.getByRole('heading', { name: 'Vos coordonnées' })).toBeDefined()
  await user.type(screen.getByLabelText('Votre nom'), 'Synthetic Visitor')
  await user.type(
    screen.getByLabelText('Adresse e-mail', { selector: 'input' }),
    'invitee@example.invalid',
  )
  await user.click(screen.getByRole('button', { name: 'Confirmer la réservation' }))
  await screen.findByRole('heading', { name: 'Votre réservation est confirmée' })
}

describe('French public booking language', () => {
  it('switches the calendar, slots, form and confirmation to French and saves the booking language', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...eventRoutes(EVENT, ['2026-11-02T14:00:00Z']),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, { booking: booking(), manageToken: TOKEN }),
    })
    renderApp('/ada/intro')
    await screen.findByRole('heading', { name: 'Intro call' })
    await user.selectOptions(screen.getByLabelText('Interface language'), 'fr')
    expect(screen.getByRole('heading', { name: 'Choisissez un horaire' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'novembre 2026' })).toBeDefined()
    await completeBooking(user)
    expect(screen.getByRole('heading', { name: 'Ajouter à votre calendrier' })).toBeDefined()
    expect(api.to('POST /api/v1/public/ada/intro/bookings')[0]?.body).toHaveProperty(
      'invitee.locale',
      'fr',
    )
    expect(document.documentElement.lang).toBe('fr')
    expect(document.documentElement.dir).toBe('ltr')
  })

  it.each(['fr-CA', 'fr-BE', 'fr-CH'])(
    'uses French dates and persists French from browser language %s without a switcher choice',
    async (regional) => {
      const user = userEvent.setup()
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue([regional])
      const api = fakeApi({
        ...eventRoutes(EVENT, ['2026-11-02T14:00:00Z']),
        'POST /api/v1/public/ada/intro/bookings': () =>
          json(201, { booking: booking(), manageToken: TOKEN }),
      })
      renderApp('/ada/intro')
      await screen.findByRole('button', { name: day })
      expect(screen.getByLabelText<HTMLSelectElement>('Langue de l’interface').value).toBe('fr')
      const zone = screen.getByRole('button', { name: /Fuseau horaire/ })
      expect(zone.textContent).toContain('Europe/Paris')
      expect(zone.textContent).toContain('GMT+01:00')
      expect(translateMessage('fr', dateMessage('2026-11-02'))).toBe(
        new Intl.DateTimeFormat('fr-FR', {
          calendar: 'gregory',
          timeZone: 'UTC',
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }).format(new Date('2026-11-02T00:00:00Z')),
      )
      await completeBooking(user)
      expect(api.to('POST /api/v1/public/ada/intro/bookings')[0]?.body).toHaveProperty(
        'invitee.locale',
        'fr',
      )
    },
  )

  it('uses provider wording and identifies the time-zone search value as a UTC offset', () => {
    expect(translateMessage('fr', 'Join Google Meet')).toBe('Participer avec Google Meet')
    expect(translateMessage('fr', 'Google Calendar')).toBe('Google Agenda')
    expect(translateMessage('fr', 'Reconnect Google Calendar')).toBe('Reconnecter Google Agenda')
    expect(
      translateMessage(
        'fr',
        'The host needs to reconnect the original Google Calendar account before retrying.',
      ),
    ).toBe('L’hôte doit reconnecter le compte Google Agenda d’origine avant de réessayer.')
    expect(translateMessage('fr', 'Search by city or offset')).toBe(
      'Rechercher par ville ou décalage UTC',
    )
  })

  it('preserves uncertainty about why an event link is missing', async () => {
    chooseLanguage('fr')
    fakeApi({ 'GET /api/v1/public/ada/intro': () => json(404, { error: 'event_type_not_found' }) })
    renderApp('/ada/intro')
    expect(
      await screen.findByText(
        'Le lien comporte peut-être une erreur de saisie, ou l’hôte a peut-être supprimé ou renommé cet événement.',
      ),
    ).toBeDefined()
  })

  it.each([1, 2])('keeps the retry delay grammatical for %i seconds', async (seconds) => {
    chooseLanguage('fr')
    fakeApi({
      'GET /api/v1/public/ada/intro': () =>
        new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(seconds) },
        }),
    })
    renderApp('/ada/intro')
    expect(
      await screen.findByText(`Trop de requêtes depuis votre réseau. Réessayez dans ${seconds} s.`),
    ).toBeDefined()
  })

  it('announces zero time-zone matches without a plural agreement error', async () => {
    const user = userEvent.setup()
    chooseLanguage('fr')
    fakeApi(eventRoutes(EVENT, ['2026-11-02T14:00:00Z']))
    renderApp('/ada/intro')
    await user.click(await screen.findByRole('button', { name: /Fuseau horaire/ }))
    await user.type(
      screen.getByRole('combobox', { name: 'Rechercher un fuseau horaire' }),
      'atlantis',
    )
    expect(screen.getAllByRole('status').map((status) => status.textContent)).toContain(
      'Nombre de fuseaux horaires : 0',
    )
  })

  it.each([0, 1, 2])('keeps slot-count grammar and the date intact for %i slots', (count) => {
    expect(
      translateMessage(
        'fr',
        msg('{count} times available on {day}.', { count, day: 'lundi 2 novembre' }),
      ),
    ).toBe(`Horaires disponibles le lundi 2 novembre : ${count}.`)
  })

  it('distinguishes previous and new times on the move confirmation with French dates', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr'])
    fakeApi({
      'GET /api/v1/bookings/manage': () => json(200, managed()),
      'GET /api/v1/bookings/manage/slots': slotsAnswer(['2026-11-03T15:00:00Z']),
    })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    await user.click(await screen.findByRole('button', { name: 'mardi 3 novembre, disponible' }))
    await user.click(
      within(screen.getByRole('list', { name: 'Horaires du mardi 3 novembre' })).getByRole(
        'button',
      ),
    )
    expect(screen.getByRole('heading', { name: 'Replanifier votre réservation ?' })).toBeDefined()
    const previous = screen.getByText('Horaire précédent', { selector: 'dt' })
    const next = screen.getByText('Nouvel horaire', { selector: 'dt' })
    expect(previous.nextElementSibling?.textContent).toContain('lundi 2 novembre 2026')
    expect(next.nextElementSibling?.textContent).toContain('mardi 3 novembre 2026')
    expect(screen.queryByText('De', { selector: 'dt' })).toBeNull()
    expect(screen.queryByText('À', { selector: 'dt' })).toBeNull()
  })

  it('translates private management and makes the widget close action refer to the window', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr'])
    fakeApi({ 'GET /api/v1/bookings/manage': () => json(200, managed()) })
    renderApp(`/booking#token=${TOKEN}`)
    expect(await screen.findByRole('button', { name: 'Annuler la réservation' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Replanifier' })).toBeDefined()
    expect(widgetMessages('fr')).toMatchObject({
      iframe: 'Réserver une réunion avec Hourmere',
      title: 'Réserver une réunion',
      close: 'Fermer',
      closeLabel: 'Fermer la fenêtre de réservation',
    })
  })

  it.each(['en', 'zh-CN'])(
    'keeps the admin surface in %s with a saved French public preference',
    async (browser) => {
      chooseLanguage('fr')
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-CA', browser])
      fakeApi({ ...signedIn, ...profile({ ...PROFILE, locale: 'fr-CH' }) })
      renderApp('/app/settings')
      await screen.findByRole('heading', { name: browser === 'en' ? 'Settings' : '设置' })
      await waitFor(() =>
        expect(document.querySelector<HTMLSelectElement>('.language-picker select')?.value).toBe(
          browser,
        ),
      )
      const picker = screen.getByLabelText<HTMLSelectElement>(
        browser === 'en' ? 'Interface language' : '界面语言',
      )
      expect([...picker.options].map(({ value }) => value)).toEqual(['en', 'zh-CN'])
      expect(localStorage.getItem('hourmere-language')).toBe('fr')
    },
  )
})
