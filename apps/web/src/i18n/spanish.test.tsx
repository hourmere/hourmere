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

const day = 'lunes, 2 de noviembre, disponible'

async function completeBooking(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: day }))
  const times = screen.getByRole('list', { name: 'Horarios del lunes, 2 de noviembre' })
  await user.click(within(times).getByRole('button', { name: '15:00' }))
  expect(screen.getByRole('heading', { name: 'Sus datos' })).toBeDefined()
  await user.type(screen.getByLabelText('Su nombre'), 'Synthetic Visitor')
  await user.type(
    screen.getByLabelText('Correo electrónico', { selector: 'input' }),
    'invitee@example.invalid',
  )
  await user.click(screen.getByRole('button', { name: 'Confirmar reserva' }))
  await screen.findByRole('heading', { name: 'Su reserva está confirmada' })
}

describe('Spanish public booking language', () => {
  it('switches the calendar, slots, form and confirmation to Spanish and saves the booking language', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...eventRoutes(EVENT, ['2026-11-02T14:00:00Z']),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, { booking: booking(), manageToken: TOKEN }),
    })
    renderApp('/ada/intro')
    await screen.findByRole('heading', { name: 'Intro call' })
    await user.selectOptions(screen.getByLabelText('Interface language'), 'es')
    expect(screen.getByRole('heading', { name: 'Elija un horario' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'noviembre de 2026' })).toBeDefined()
    await completeBooking(user)
    expect(screen.getByRole('heading', { name: 'Añadir a su calendario' })).toBeDefined()
    expect(api.to('POST /api/v1/public/ada/intro/bookings')[0]?.body).toHaveProperty(
      'invitee.locale',
      'es',
    )
    expect(document.documentElement.lang).toBe('es')
    expect(document.documentElement.dir).toBe('ltr')
  })

  it.each(['es-ES', 'es-MX', 'es-419', 'es-AR', 'es-CO', 'es-US'])(
    'uses Spanish dates and persists Spanish from browser language %s without a switcher choice',
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
      expect(screen.getByLabelText<HTMLSelectElement>('Idioma de la interfaz').value).toBe('es')
      const zone = screen.getByRole('button', { name: /Zona horaria/ })
      expect(zone.textContent).toContain('Europe/Paris')
      expect(zone.textContent).toContain('GMT+01:00')
      expect(translateMessage('es', dateMessage('2026-11-02'))).toBe(
        new Intl.DateTimeFormat('es-ES', {
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
        'es',
      )
    },
  )

  it('uses provider wording and identifies the time-zone search value as a UTC offset', () => {
    expect(translateMessage('es', 'Join Google Meet')).toBe('Unirse con Google Meet')
    expect(translateMessage('es', 'Google Calendar')).toBe('Google Calendar')
    expect(translateMessage('es', 'Reconnect Google Calendar')).toBe(
      'Volver a conectar Google Calendar',
    )
    expect(
      translateMessage(
        'es',
        'The host needs to reconnect the original Google Calendar account before retrying.',
      ),
    ).toBe(
      'El anfitrión debe volver a conectar la cuenta original de Google Calendar antes de reintentarlo.',
    )
    expect(translateMessage('es', 'Search by city or offset')).toBe(
      'Buscar por ciudad o diferencia con UTC',
    )
  })

  it('distinguishes reconnecting a calendar from signing in and an availability schedule from a calendar', () => {
    expect(translateMessage('es', 'Reconnect before enabling busy times.')).toBe(
      'Vuelva a conectar el calendario antes de activar la consulta de horarios ocupados.',
    )
    expect(translateMessage('es', 'Calendar')).toBe('Calendario')
    expect(
      translateMessage('es', 'Make another schedule the default before deleting this one'),
    ).toBe('Establezca otra configuración de disponibilidad como predeterminada antes de eliminar esta')
  })

  it('preserves uncertainty about why an event link is missing', async () => {
    chooseLanguage('es')
    fakeApi({ 'GET /api/v1/public/ada/intro': () => json(404, { error: 'event_type_not_found' }) })
    renderApp('/ada/intro')
    expect(
      await screen.findByText(
        'Es posible que el enlace contenga un error o que el anfitrión haya eliminado este evento o cambiado su nombre.',
      ),
    ).toBeDefined()
  })

  it.each([1, 2])('keeps the retry delay grammatical for %i seconds', async (seconds) => {
    chooseLanguage('es')
    fakeApi({
      'GET /api/v1/public/ada/intro': () =>
        new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(seconds) },
        }),
    })
    renderApp('/ada/intro')
    expect(
      await screen.findByText(
        `Hay demasiadas solicitudes desde su red. Vuelva a intentarlo en ${seconds} s.`,
      ),
    ).toBeDefined()
  })

  it('announces zero time-zone matches without a plural agreement error', async () => {
    const user = userEvent.setup()
    chooseLanguage('es')
    fakeApi(eventRoutes(EVENT, ['2026-11-02T14:00:00Z']))
    renderApp('/ada/intro')
    await user.click(await screen.findByRole('button', { name: /Zona horaria/ }))
    await user.type(screen.getByRole('combobox', { name: 'Buscar zonas horarias' }), 'atlantis')
    expect(screen.getAllByRole('status').map((status) => status.textContent)).toContain(
      'Número de zonas horarias: 0',
    )
  })

  it.each([0, 1, 2])('keeps slot-count grammar and the date intact for %i slots', (count) => {
    expect(
      translateMessage(
        'es',
        msg('{count} times available on {day}.', { count, day: 'lunes, 2 de noviembre' }),
      ),
    ).toBe(`Horarios disponibles el lunes, 2 de noviembre: ${count}.`)
  })

  it('distinguishes previous and new times on the move confirmation with Spanish dates', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['es'])
    fakeApi({
      'GET /api/v1/bookings/manage': () => json(200, managed()),
      'GET /api/v1/bookings/manage/slots': slotsAnswer(['2026-11-03T15:00:00Z']),
    })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    await user.click(
      await screen.findByRole('button', { name: 'martes, 3 de noviembre, disponible' }),
    )
    await user.click(
      within(screen.getByRole('list', { name: 'Horarios del martes, 3 de noviembre' })).getByRole(
        'button',
      ),
    )
    expect(screen.getByRole('heading', { name: '¿Reprogramar su reserva?' })).toBeDefined()
    const previous = screen.getByText('Horario anterior', { selector: 'dt' })
    const next = screen.getByText('Nuevo horario', { selector: 'dt' })
    expect(previous.nextElementSibling?.textContent).toContain('lunes, 2 de noviembre de 2026')
    expect(next.nextElementSibling?.textContent).toContain('martes, 3 de noviembre de 2026')
    expect(screen.queryByText('Desde', { selector: 'dt' })).toBeNull()
    expect(screen.queryByText('Hasta', { selector: 'dt' })).toBeNull()
  })

  it('translates private management and makes the widget close action refer to the window', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['es'])
    fakeApi({ 'GET /api/v1/bookings/manage': () => json(200, managed()) })
    renderApp(`/booking#token=${TOKEN}`)
    expect(await screen.findByRole('button', { name: 'Cancelar reserva' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reprogramar' })).toBeDefined()
    expect(widgetMessages('es')).toMatchObject({
      iframe: 'Reservar una reunión con Hourmere',
      title: 'Reservar una reunión',
      close: 'Cerrar',
      closeLabel: 'Cerrar la ventana de reserva',
    })
  })

  it.each(['en', 'zh-CN'])(
    'keeps the admin surface in %s with a saved Spanish public preference',
    async (browser) => {
      chooseLanguage('es')
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['es-MX', browser])
      fakeApi({ ...signedIn, ...profile({ ...PROFILE, locale: 'es-US' }) })
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
      expect(localStorage.getItem('hourmere-language')).toBe('es')
    },
  )
})
