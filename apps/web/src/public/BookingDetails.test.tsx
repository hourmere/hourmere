import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from '../i18n/store.ts'
import { translateMessage } from '../i18n/translate.ts'
import { LocationDetails, locationText, When } from './BookingDetails.tsx'

it('keeps the numeric offset in an unbroken span', () => {
  const { container } = render(
    <When
      start="2026-07-01T14:00:00Z"
      end="2026-07-01T14:30:00Z"
      timeZone="America/Los_Angeles"
      locale="en-US"
    />,
  )
  expect(container.querySelector('.time-offset')?.textContent).toBe('GMT-07:00)')
})

describe('pure conference location presentation', () => {
  it('shows a trusted participant link and preserves its capability only in the protected display', () => {
    const url = 'https://us02web.zoom.us/j/81234567890?pwd=synthetic-only.1'
    render(<LocationDetails location={{ kind: 'zoom', autoCreate: true, url }} />)
    expect(screen.getByRole('link').getAttribute('href')).toBe(url)
    expect(screen.getByRole('link').getAttribute('rel')).toContain('noreferrer')
    expect(screen.getByRole('link', { name: url }).querySelector('bdi[dir=ltr]')?.textContent).toBe(
      url,
    )
    expect(locationText({ kind: 'zoom', autoCreate: true, url })).toBe(`Zoom: ${url}`)
  })
  it.each([
    'https://evil.invalid/j/81234567890',
    'https://us02web.zoom.us/j/81234567890?start_url=private',
    'javascript:alert(1)',
  ])('never renders or exports untrusted provider detail %s', (url) => {
    render(<LocationDetails location={{ kind: 'zoom', autoCreate: true, url }} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(locationText({ kind: 'zoom', autoCreate: true, url })).toBe('Zoom')
  })
})

describe('Microsoft Teams location details', () => {
  const url = 'https://teams.microsoft.com/l/meetup-join/fake-meeting/0'
  it.each([
    [
      'en',
      'Join Microsoft Teams',
      'The Teams link isn’t ready yet.',
      'The booking is still scheduled without a Teams link.',
    ],
    [
      'zh-CN',
      '加入 Microsoft Teams 会议',
      'Teams 会议链接尚未就绪。',
      '预约仍然有效，但没有 Teams 会议链接。',
    ],
    [
      'de',
      'Über Microsoft Teams teilnehmen',
      'Der Teams-Link ist noch nicht verfügbar.',
      'Die Buchung bleibt auch ohne Teams-Link bestehen.',
    ],
    [
      'fr',
      'Rejoindre la réunion Microsoft Teams',
      'Le lien Teams n’est pas encore disponible.',
      'La réservation reste confirmée, sans lien Teams.',
    ],
    [
      'es',
      'Unirse a la reunión de Microsoft Teams',
      'El enlace de Teams aún no está listo.',
      'La reserva sigue confirmada, sin enlace de Teams.',
    ],
    [
      'pt-BR',
      'Participar da reunião no Microsoft Teams',
      'O link do Teams ainda não está pronto.',
      'A reserva continua confirmada, sem um link do Teams.',
    ],
  ] as const)('renders Teams meeting locations in %s', (locale, join, pending, fallback) => {
    chooseLanguage(locale)
    const { rerender } = render(
      <LocationDetails location={{ kind: 'microsoft_teams', status: 'join_url_pending', url }} />,
    )
    expect(screen.getByText(pending)).toBeDefined()
    expect(screen.queryByRole('link')).toBeNull()
    expect(locationText({ kind: 'microsoft_teams', status: 'join_url_pending', url })).toBe(
      'Microsoft Teams',
    )
    rerender(
      <LocationDetails location={{ kind: 'microsoft_teams', status: 'teams_unavailable' }} />,
    )
    expect(screen.getByText(fallback)).toBeDefined()
    expect(screen.queryByRole('link')).toBeNull()
    rerender(
      <LocationDetails location={{ kind: 'microsoft_teams', status: 'writeback_failed', url }} />,
    )
    expect(screen.getByText(fallback)).toBeDefined()
    expect(screen.queryByText(pending)).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(locationText({ kind: 'microsoft_teams', status: 'writeback_failed', url })).toBe(
      'Microsoft Teams',
    )
    rerender(<LocationDetails location={{ kind: 'microsoft_teams', status: 'ready', url }} />)
    const link = screen.getByRole('link', { name: join })
    expect(link.getAttribute('href')).toBe(url)
    expect(link.getAttribute('rel')).toContain('noreferrer')
    expect(locationText({ kind: 'microsoft_teams', status: 'ready', url })).toBe(
      `Microsoft Teams: ${url}`,
    )
    rerender(
      <LocationDetails location={{ kind: 'microsoft_teams', status: 'ready', url }} cancelled />,
    )
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('never renders a look-alike Teams URL', () => {
    const url = 'https://teams.microsoft.com.evil.invalid/l/meetup-join/fake-meeting/0'
    render(<LocationDetails location={{ kind: 'microsoft_teams', status: 'ready', url }} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(locationText({ kind: 'microsoft_teams', status: 'ready', url })).toBe('Microsoft Teams')
  })
})

describe('localized booking detail punctuation', () => {
  it.each([
    [{ kind: 'phone', number: '+14155550123' }, '电话会议：+14155550123'],
    [{ kind: 'in_person', address: 'Meeting room' }, '线下见面：Meeting room'],
    [
      { kind: 'link', url: 'https://example.invalid/meeting' },
      '线上会议：https://example.invalid/meeting',
    ],
  ] as const)('localizes the colon before %s details', (location, expected) => {
    chooseLanguage('zh-CN')
    const { container } = render(<LocationDetails location={location} />)
    expect(container.textContent).toBe(expected)
    expect(
      locationText(
        location,
        (key) => translateMessage('zh-CN', key),
        translateMessage('zh-CN', ': '),
      ),
    ).toBe(expected)
  })
  it('uses Chinese brackets and comma for the displayed zone', () => {
    chooseLanguage('zh-CN')
    const { container } = render(
      <When
        start="2026-11-02T14:00:00Z"
        end="2026-11-02T14:30:00Z"
        timeZone="Europe/Berlin"
        locale="zh-CN"
      />,
    )
    expect(container.querySelector('.muted')?.textContent).toBe('（Europe/Berlin，GMT+01:00）')
  })
})

describe('unspecified location', () => {
  it.each([
    ['en', 'No location has been specified. Contact the host for meeting details.'],
    ['zh-CN', '尚未指定会议地点。请联系主持人了解会议详情。'],
    [
      'de',
      'Es wurde kein Ort angegeben. Wenden Sie sich für die Besprechungsdetails an die gastgebende Person.',
    ],
    [
      'fr',
      'Aucun lieu n’a été précisé. Contactez l’hôte pour connaître les détails de la réunion.',
    ],
    [
      'es',
      'No se ha especificado un lugar. Contacta con el anfitrión para conocer los detalles de la reunión.',
    ],
    [
      'pt-BR',
      'Nenhum local foi especificado. Entre em contato com o anfitrião para saber os detalhes da reunião.',
    ],
  ] as const)(
    'explains the absent location in %s without inventing a calendar location',
    (locale, expected) => {
      chooseLanguage(locale)
      const { container } = render(<LocationDetails location={null} />)
      expect(container.textContent).toBe(expected)
      expect(screen.queryByRole('link')).toBeNull()
      expect(locationText(null)).toBeUndefined()
    },
  )
})
