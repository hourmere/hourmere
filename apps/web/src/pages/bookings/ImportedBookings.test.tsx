import { screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, profile, renderApp, signedIn } from '../../test/fake-api.tsx'
import { BOOKING_ID, booking } from '../../test/fixtures.ts'
import { managed, TOKEN } from '../../test/public-fixtures.ts'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2030-03-01T12:00:00Z'))
})

afterEach(() => vi.useRealTimers())

describe('imported booking administration', () => {
  it.each([
    ['en', 'This imported booking is read-only and managed in the original system.'],
    ['zh-CN', '此导入预约为只读记录，请在原系统中管理。'],
    [
      'de',
      'Diese importierte Buchung ist schreibgeschützt und wird im ursprünglichen System verwaltet.',
    ],
    [
      'fr',
      'Cette réservation importée est en lecture seule et reste gérée dans le système d’origine.',
    ],
    ['es', 'Esta reserva importada es de solo lectura y se gestiona en el sistema original.'],
    [
      'pt-BR',
      'Este agendamento importado é somente leitura e continua sendo gerenciado no sistema original.',
    ],
  ] as const)('keeps a stale public import response read-only in %s', async (locale, message) => {
    chooseLanguage(locale)
    const api = fakeApi({
      'GET /api/v1/bookings/manage': () => json(200, managed({ source: 'import' })),
    })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    await screen.findByText(message)
    expect(
      screen
        .queryAllByRole('button')
        .every((button) => button.classList.contains('public-language-trigger')),
    ).toBe(true)
    expect(document.querySelector('a[download], a[href*="#token="]')).toBeNull()
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it.each([
    ['en', 'Imported', 'This imported booking is read-only and managed in the original system.'],
    ['zh-CN', '已导入', '此导入预约为只读记录，请在原系统中管理。'],
  ] as const)(
    'labels %s imports and omits all management/retry controls',
    async (locale, label, message) => {
      chooseLanguage(locale)
      const imported = booking({
        source: 'import',
        managementPolicy: 'local_only_read_only',
        start: '2030-03-04T09:00:00Z',
        end: '2030-03-04T09:30:00Z',
        questions: [{ id: 'notes', label: 'Original notes', type: 'long_text', required: false }],
        responses: { notes: 'Retained source notes' },
        conference: { provider: 'zoom', status: 'failed', errorCode: 'provider_unavailable' },
        conferenceCanRetry: true,
        calendarCopy: { status: 'failed', errorCode: 'provider_unavailable', canRetry: true },
      })
      const api = fakeApi({
        ...signedIn,
        ...profile(),
        'GET /api/v1/bookings': () => json(200, { data: [imported], nextCursor: null }),
        [`GET /api/v1/bookings/${BOOKING_ID}`]: () => json(200, imported),
      })
      renderApp(`/app/bookings/${BOOKING_ID}`)
      await screen.findByText(message)
      expect(screen.getByText(label)).toBeDefined()
      expect(screen.getByText('Original notes')).toBeDefined()
      expect(screen.getByText('Retained source notes')).toBeDefined()
      expect(
        screen.queryByRole('button', {
          name: /reschedule|改期|cancel|取消|retry|重试|reconcile|核对/i,
        }),
      ).toBeNull()
      expect(
        screen.queryByRole('region', {
          name: /Meeting link|My calendar copy|会议链接|我的日历副本/i,
        }),
      ).toBeNull()
      expect(document.querySelector('a[download], a[href*="#token="]')).toBeNull()
      expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
    },
  )

  it('marks imported busy records in the booking list', async () => {
    chooseLanguage('en')
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/bookings': () =>
        json(200, {
          data: [booking({ source: 'import', managementPolicy: 'local_only_read_only' })],
          nextCursor: null,
        }),
    })
    renderApp('/app/bookings')
    const title = await screen.findByRole('rowheader', { name: 'Intro call' })
    expect(within(title.closest('tr') as HTMLTableRowElement).getByText('Imported')).toBeDefined()
  })

  it('renders unknown sources neutrally without inventing a management capability', async () => {
    chooseLanguage('en')
    fakeApi({
      ...signedIn,
      ...profile(),
      [`GET /api/v1/bookings/${BOOKING_ID}`]: () =>
        json(
          200,
          booking({
            source: 'future_source' as 'web',
            eventTypeId: null,
            start: '2029-03-04T09:00:00Z',
            end: '2029-03-04T09:30:00Z',
          }),
        ),
    })
    renderApp(`/app/bookings/${BOOKING_ID}`)
    await screen.findByRole('heading', { name: 'Intro call' })
    expect(screen.getByText(/through Unknown/)).toBeDefined()
  })
})
