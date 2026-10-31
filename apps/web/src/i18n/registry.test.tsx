import { type InterfaceLanguage, registeredLocales } from '@hourmere/core/language'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { widgetMessages } from '../embed/language.ts'
import {
  fakeApi,
  json,
  ME,
  PROFILE,
  profile,
  renderApp,
  signedIn,
  signedInAs,
} from '../test/fake-api.tsx'
import { booking, EVENT, eventRoutes } from '../test/public-fixtures.ts'
import { selectPublicLanguage } from '../test/public-language.ts'
import { registerCatalogues } from './catalogues.ts'
import { formatDuration, formatMinutes } from './duration.ts'
import { AccountLanguage, LanguageSwitcher, useI18n } from './runtime.tsx'
import { resetLanguagePreference } from './store.ts'
import { dateMessage, type MessageKey, translate, translateMessage } from './translate.ts'

// This fixture exists only in this test module. Production remains English + Chinese.
vi.hoisted(() => vi.resetModules())
vi.mock('@hourmere/core/locales', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hourmere/core/locales')>()
  return {
    ...original,
    localeRegistry: {
      ...original.localeRegistry,
      qaa: {
        code: 'qaa',
        nativeName: 'Fixture language',
        fallbacks: ['en'],
        formatLocale: 'de-DE',
        direction: 'ltr',
      },
    },
  }
})
vi.mock('./common.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./common.ts')>()
  return {
    ...original,
    commonCatalogues: {
      ...original.commonCatalogues,
      './catalogues/qaa/common.ts': {
        'Your details': 'Fixture details',
        '{count} min': 'Fixture {count}m',
      },
    },
  }
})
vi.mock('../public/env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public/env.ts')>()),
  detectTimeZone: () => 'America/New_York',
  preferredLocale: () => 'en-GB',
  now: () => Date.parse('2026-11-01T04:30:00Z'),
}))

const fixture = 'qaa' as InterfaceLanguage
beforeEach(() => resetLanguagePreference())

function Notice() {
  const { t, ui, formatLocale } = useI18n()
  return (
    <>
      <LanguageSwitcher />
      <p>{t('Your details')}</p>
      <p>{t('Email')}</p>
      <output data-testid="date">{ui(dateMessage('2026-05-02'))}</output>
      <output data-testid="format-locale">{formatLocale ?? 'browser'}</output>
    </>
  )
}

describe('a locale registered only by metadata and catalogue files', () => {
  it('loads its catalogue, switches without losing English keys and uses its formatting metadata', async () => {
    const user = userEvent.setup()
    render(<Notice />)
    expect(registeredLocales.some(({ code }) => code === fixture)).toBe(true)
    expect(
      [...screen.getByLabelText<HTMLSelectElement>('Interface language').options].map(
        ({ value }) => value,
      ),
    ).toContain(fixture)
    await user.selectOptions(screen.getByLabelText('Interface language'), fixture)
    expect(screen.getByText('Fixture details')).toBeDefined()
    expect(screen.getByText('Email')).toBeDefined()
    expect(screen.getByTestId('format-locale').textContent).toBe('de-DE')
    expect(screen.getByTestId('date').textContent).toBe(
      new Intl.DateTimeFormat('de-DE', {
        calendar: 'gregory',
        timeZone: 'UTC',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(new Date('2026-05-02T00:00:00Z')),
    )
    expect(document.documentElement.lang).toBe(fixture)
    expect(document.documentElement.dir).toBe('ltr')
  })

  it('resolves each missing key and nested message from English source values', () => {
    registerCatalogues({
      './catalogues/en/common.ts': { 'fixture.only': 'English fallback {name}' },
    })
    const key = 'fixture.only' as MessageKey
    expect(translate(fixture, key, { name: 'Ada' })).toBe('English fallback Ada')
    expect(translateMessage(fixture, { key, values: { name: 'Ada' } })).toBe('English fallback Ada')
    expect(translateMessage(fixture, 'fixture.only')).toBe('English fallback {name}')
    expect(translate(fixture, 'Your details')).toBe('Fixture details')
    expect(formatDuration(30, fixture)).toBe('Fixture 30m')
    expect(formatMinutes(30, fixture)).toBe('Fixture 30m')
    expect(widgetMessages(fixture)).toMatchObject({ title: 'Book a meeting', close: 'Close' })
  })

  it('applies a registered account locale to dates before an explicit choice', () => {
    render(
      <AccountLanguage locale={fixture}>
        <Notice />
      </AccountLanguage>,
    )
    expect(screen.getByText('Fixture details')).toBeDefined()
    expect(screen.getByTestId('format-locale').textContent).toBe('de-DE')
  })

  it('uses registered browser formatting after an unsupported first preference', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['qab', fixture])
    render(<Notice />)
    expect(screen.getByText('Fixture details')).toBeDefined()
    expect(screen.getByTestId('format-locale').textContent).toBe('de-DE')
  })

  it('offers and saves a newly registered notification language through the real settings form', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...signedIn,
      ...profile(PROFILE),
      'PUT /api/v1/profile': ({ body }) => json(200, { ...PROFILE, ...(body as object) }),
    })
    renderApp('/app/settings')
    const languages = await screen.findByLabelText<HTMLSelectElement>('Notification language')
    expect([...languages.options].map(({ value }) => value)).toContain(fixture)
    await user.selectOptions(languages, fixture)
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => expect(api.to('PUT /api/v1/profile')).toHaveLength(1))
    await screen.findByText('Saved.')
    expect(api.to('PUT /api/v1/profile')[0]?.body).toMatchObject({ locale: fixture })
  })

  it('keeps team creation and the current role alongside a registry-only notification language', async () => {
    const user = userEvent.setup()
    const team = { ...ME, organization: { ...ME.organization, personal: false } }
    const api = fakeApi({
      ...signedInAs(team),
      ...profile(PROFILE),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, {
          id: 'fixture-member',
          organizationId: team.organization.id,
          userId: team.user.id,
          role: 'admin',
          createdAt: '2026-10-27T10:00:00.000Z',
        }),
      'PUT /api/v1/profile': ({ body }) => json(200, { ...PROFILE, ...(body as object) }),
    })
    renderApp('/app/settings')
    const account = await screen.findByRole('region', { name: 'Account' })
    await waitFor(() => expect(within(account).queryByText('Admin')).not.toBeNull())
    await user.selectOptions(screen.getByLabelText('Interface language'), fixture)
    expect(within(account).getByText('Your role')).toBeDefined()
    expect(within(account).getByText('Admin')).toBeDefined()
    expect(within(account).queryByRole('link', { name: 'Create team' })?.getAttribute('href')).toBe(
      '/app/teams/new',
    )
    await user.selectOptions(screen.getByLabelText('Notification language'), fixture)
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    await screen.findByText('Saved.')
    expect(api.to('PUT /api/v1/profile')[0]?.body).toMatchObject({ locale: fixture })
    expect(within(account).getByText('Admin')).toBeDefined()
  })

  it('formats public booking dates in the registry locale and captures the chosen language in the request', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...eventRoutes(EVENT, ['2026-11-02T14:00:00Z']),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, { booking: booking(), manageToken: 'fixture_capability' }),
    })
    renderApp('/ada/intro')
    await screen.findByRole('heading', { name: 'Intro call' })
    await selectPublicLanguage(user, fixture)
    const date = new Intl.DateTimeFormat('de-DE', {
      calendar: 'gregory',
      timeZone: 'UTC',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(new Date('2026-11-02T00:00:00Z'))
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('button')].some(
          (button) => button.getAttribute('aria-label') === `${date}, available`,
        ),
      ).toBe(true),
    )
    await user.click(await screen.findByRole('button', { name: `${date}, available` }))
    const times = screen.getByRole('list', { name: `Times on ${date}` })
    await user.click(times.querySelector('button') as HTMLButtonElement)
    expect(screen.getByText('Fixture details')).toBeDefined()
    await user.type(screen.getByLabelText('Your name'), 'Synthetic invitee')
    await user.type(
      screen.getByLabelText('Email', { selector: 'input' }),
      'invitee@example.invalid',
    )
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    expect(api.to('POST /api/v1/public/ada/intro/bookings')[0]?.body).toHaveProperty(
      'invitee.locale',
      fixture,
    )
  })
})
