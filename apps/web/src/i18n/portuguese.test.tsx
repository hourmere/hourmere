import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { embedQueryLanguage, widgetLanguage, widgetMessages } from '../embed/language.ts'
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

const day = 'segunda-feira, 2 de novembro, disponível'

async function completeBooking(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: day }))
  const times = screen.getByRole('list', { name: 'Horários de segunda-feira, 2 de novembro' })
  await user.click(within(times).getByRole('button', { name: '15:00' }))
  expect(screen.getByRole('heading', { name: 'Seus dados' })).toBeDefined()
  await user.type(screen.getByLabelText('Seu nome'), 'Synthetic Visitor')
  await user.type(screen.getByLabelText('E-mail', { selector: 'input' }), 'invitee@example.invalid')
  await user.click(screen.getByRole('button', { name: 'Confirmar agendamento' }))
  await screen.findByRole('heading', { name: 'Agendamento confirmado' })
}

describe('Brazilian Portuguese public booking language', () => {
  it('switches the calendar, slots, form and confirmation to Brazilian Portuguese and saves the booking language', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...eventRoutes(EVENT, ['2026-11-02T14:00:00Z']),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, { booking: booking(), manageToken: TOKEN }),
    })
    renderApp('/ada/intro')
    await screen.findByRole('heading', { name: 'Intro call' })
    await user.selectOptions(screen.getByLabelText('Interface language'), 'pt-BR')
    expect(screen.getByRole('heading', { name: 'Escolha um horário' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'novembro de 2026' })).toBeDefined()
    await completeBooking(user)
    expect(screen.getByRole('heading', { name: 'Adicionar à sua agenda' })).toBeDefined()
    expect(api.to('POST /api/v1/public/ada/intro/bookings')[0]?.body).toHaveProperty(
      'invitee.locale',
      'pt-BR',
    )
    expect(document.documentElement.lang).toBe('pt-BR')
    expect(document.documentElement.dir).toBe('ltr')
  })

  it('keeps the powered by wording in the Brazilian Portuguese attribution', async () => {
    chooseLanguage('pt-BR')
    fakeApi(eventRoutes(EVENT, ['2026-11-02T14:00:00Z']))
    renderApp('/ada/intro')
    await screen.findByRole('heading', { name: 'Escolha um horário' })
    expect(screen.getByRole('link', { name: 'Powered by Hourmere' })).toBeDefined()
  })

  it('keeps the powered by wording in Brazilian Portuguese search and sharing descriptions', async () => {
    const metas = ['description', 'og:description'].map((name) => {
      const meta = document.createElement('meta')
      meta.setAttribute(name.startsWith('og:') ? 'property' : 'name', name)
      document.head.append(meta)
      return meta
    })
    try {
      chooseLanguage('pt-BR')
      fakeApi(eventRoutes(EVENT, ['2026-11-02T14:00:00Z']))
      renderApp('/ada/intro')
      await screen.findByRole('heading', { name: 'Escolha um horário' })
      for (const meta of metas)
        expect(meta.getAttribute('content')).toBe(
          'Página de agendamento powered by Hourmere — escolha um horário que funcione para você.',
        )
    } finally {
      for (const meta of metas) meta.remove()
    }
  })

  it.each(['pt-BR', 'pt', 'PT-br', 'pt-Latn-BR', 'pt-AO'])(
    'uses Brazilian Portuguese dates and persists Brazilian Portuguese from browser language %s without a switcher choice',
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
      expect(screen.getByLabelText<HTMLSelectElement>('Idioma da interface').value).toBe('pt-BR')
      const zone = screen.getByRole('button', { name: /Fuso horário/ })
      expect(zone.textContent).toContain('Europe/Paris')
      expect(zone.textContent).toContain('GMT+01:00')
      expect(translateMessage('pt-BR', dateMessage('2026-11-02'))).toBe(
        new Intl.DateTimeFormat('pt-BR', {
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
        'pt-BR',
      )
    },
  )

  it('uses provider wording and identifies the time-zone search value as a UTC offset', () => {
    expect(translateMessage('pt-BR', 'Join Google Meet')).toBe('Participar com o Google Meet')
    expect(translateMessage('pt-BR', 'Google Calendar')).toBe('Google Agenda')
    expect(translateMessage('pt-BR', 'Reconnect Google Calendar')).toBe(
      'Reconectar o Google Agenda',
    )
    expect(
      translateMessage(
        'pt-BR',
        'The host needs to reconnect the original Google Calendar account before retrying.',
      ),
    ).toBe(
      'O anfitrião precisa reconectar a conta original do Google Agenda antes de tentar novamente.',
    )
    expect(translateMessage('pt-BR', 'Search by city or offset')).toBe(
      'Buscar por cidade ou diferença em relação ao UTC',
    )
  })

  it('distinguishes reconnecting a calendar from signing in and an availability schedule from a calendar', () => {
    expect(translateMessage('pt-BR', 'Reconnect before enabling busy times.')).toBe(
      'Reconecte a agenda antes de ativar os horários ocupados.',
    )
    expect(translateMessage('pt-BR', 'Calendar')).toBe('Agenda')
    expect(
      translateMessage('pt-BR', 'Make another schedule the default before deleting this one'),
    ).toBe('Defina outra configuração de disponibilidade como padrão antes de excluir esta')
  })

  it('preserves uncertainty about why an event link is missing', async () => {
    chooseLanguage('pt-BR')
    fakeApi({ 'GET /api/v1/public/ada/intro': () => json(404, { error: 'event_type_not_found' }) })
    renderApp('/ada/intro')
    expect(
      await screen.findByText(
        'O link pode ter sido digitado incorretamente, ou o anfitrião pode ter removido ou renomeado este evento.',
      ),
    ).toBeDefined()
  })

  it.each([1, 2])('keeps the retry delay grammatical for %i seconds', async (seconds) => {
    chooseLanguage('pt-BR')
    fakeApi({
      'GET /api/v1/public/ada/intro': () =>
        new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(seconds) },
        }),
    })
    renderApp('/ada/intro')
    expect(
      await screen.findByText(`Muitas solicitações da sua rede. Tente novamente em ${seconds} s.`),
    ).toBeDefined()
  })

  it('announces zero time-zone matches without a plural agreement error', async () => {
    const user = userEvent.setup()
    chooseLanguage('pt-BR')
    fakeApi(eventRoutes(EVENT, ['2026-11-02T14:00:00Z']))
    renderApp('/ada/intro')
    await user.click(await screen.findByRole('button', { name: /Fuso horário/ }))
    await user.type(screen.getByRole('combobox', { name: 'Buscar fusos horários' }), 'atlantis')
    expect(screen.getAllByRole('status').map((status) => status.textContent)).toContain(
      '0 fusos horários',
    )
  })

  it.each([0, 2])('keeps slot-count grammar and the date intact for %i slots', (count) => {
    expect(
      translateMessage(
        'pt-BR',
        msg('{count} times available on {day}.', { count, day: 'segunda-feira, 2 de novembro' }),
      ),
    ).toBe(`${count} horários disponíveis — segunda-feira, 2 de novembro.`)
  })

  it('keeps singular slot-count grammar and the date intact', () => {
    expect(
      translateMessage(
        'pt-BR',
        msg('{count} time available on {day}.', {
          count: 1,
          day: 'segunda-feira, 2 de novembro',
        }),
      ),
    ).toBe('1 horário disponível — segunda-feira, 2 de novembro.')
  })

  it('distinguishes previous and new times on the move confirmation with Brazilian Portuguese dates', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['pt-BR'])
    fakeApi({
      'GET /api/v1/bookings/manage': () => json(200, managed()),
      'GET /api/v1/bookings/manage/slots': slotsAnswer(['2026-11-03T15:00:00Z']),
    })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    await user.click(
      await screen.findByRole('button', { name: 'terça-feira, 3 de novembro, disponível' }),
    )
    await user.click(
      within(
        screen.getByRole('list', { name: 'Horários de terça-feira, 3 de novembro' }),
      ).getByRole('button'),
    )
    expect(screen.getByRole('heading', { name: 'Reagendar?' })).toBeDefined()
    const previous = screen.getByText('Horário anterior', { selector: 'dt' })
    const next = screen.getByText('Novo horário', { selector: 'dt' })
    expect(previous.nextElementSibling?.textContent).toContain(
      'segunda-feira, 2 de novembro de 2026',
    )
    expect(next.nextElementSibling?.textContent).toContain('terça-feira, 3 de novembro de 2026')
    expect(screen.queryByText('De', { selector: 'dt' })).toBeNull()
    expect(screen.queryByText('Para', { selector: 'dt' })).toBeNull()
  })

  it('translates private management and makes the widget close action refer to the window', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['pt-BR'])
    fakeApi({ 'GET /api/v1/bookings/manage': () => json(200, managed()) })
    renderApp(`/booking#token=${TOKEN}`)
    expect(await screen.findByRole('button', { name: 'Cancelar agendamento' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reagendar' })).toBeDefined()
    expect(widgetMessages('pt-BR')).toMatchObject({
      iframe: 'Agende uma reunião com o Hourmere',
      title: 'Agendar uma reunião',
      close: 'Fechar',
      closeLabel: 'Fechar a janela de agendamento',
    })
  })

  it('falls back to English for European Portuguese browser and widget preferences', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['pt-PT'])
    fakeApi(eventRoutes(EVENT, ['2026-11-02T14:00:00Z']))
    renderApp('/ada/intro')
    expect(await screen.findByRole('heading', { name: 'Pick a time' })).toBeDefined()
    expect(screen.getByLabelText<HTMLSelectElement>('Interface language').value).toBe('en')
    document.documentElement.lang = 'pt-PT'
    expect(widgetLanguage()).toBe('en')
  })

  it('accepts the regional widget code exactly and negotiates bare Portuguese only as an implicit preference', () => {
    expect(widgetLanguage('pt-BR')).toBe('pt-BR')
    expect(embedQueryLanguage('?language=pt-BR')).toBe('pt-BR')
    for (const code of ['pt', 'PT-br', 'pt-PT']) {
      expect(() => widgetLanguage(code)).toThrow('Invalid Hourmere interface language')
      expect(embedQueryLanguage(`?language=${code}`)).toBeUndefined()
    }
    expect(embedQueryLanguage('?language=pt-BR&language=en')).toBeUndefined()
    document.documentElement.lang = 'pt'
    expect(widgetLanguage()).toBe('pt-BR')
  })

  it.each(['en', 'zh-CN'])(
    'keeps the admin surface in %s with a saved Brazilian Portuguese public preference',
    async (browser) => {
      chooseLanguage('pt-BR')
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['pt-BR', browser])
      fakeApi({ ...signedIn, ...profile({ ...PROFILE, locale: 'pt-BR' }) })
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
      expect(localStorage.getItem('hourmere-language')).toBe('pt-BR')
    },
  )
})
