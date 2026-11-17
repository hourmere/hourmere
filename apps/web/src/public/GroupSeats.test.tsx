import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmbedLanguage } from '../i18n/runtime.tsx'
import { translate } from '../i18n/translate.ts'
import { fakeApi, json, renderApp } from '../test/fake-api.tsx'
import { booking, EVENT, slot, TOKEN } from '../test/public-fixtures.ts'
import { selectPublicLanguage } from '../test/public-language.ts'
import { SlotPicker } from './SlotPicker.tsx'

const NOW = Date.parse('2026-11-01T04:30:00Z')
const START = '2026-11-02T14:00:00.000Z'
const NEXT = '2026-11-02T15:00:00.000Z'
const API = '/api/v1/public/ada/intro'
vi.mock('./env.ts', async (original) => ({
  ...(await original<typeof import('./env.ts')>()),
  detectTimeZone: () => 'UTC',
  preferredLocale: () => 'en-US',
  now: () => NOW,
}))
beforeAll(async () => {
  await Promise.all([import('./BookingPage.tsx'), import('./Embed.tsx')])
})
beforeEach(() => window.history.replaceState(null, '', '/'))

const languages = [
  ['en', '1 seat left', '3 seats left'],
  ['zh-CN', '剩余 1 个名额', '剩余 3 个名额'],
  ['fr', '1 place restante', '3 places restantes'],
  ['de', 'Noch 1 Platz', 'Noch 3 Plätze'],
  ['es', 'Queda 1 plaza', 'Quedan 3 plazas'],
  ['pt-BR', 'Resta 1 vaga', 'Restam 3 vagas'],
] as const

describe('public group seat information', () => {
  it.each(languages)(
    'renders natural singular and plural seat counts in %s',
    async (language, one, many) => {
      render(
        <EmbedLanguage language={language}>
          <SlotPicker
            load={async () => [
              { ...slot(START), seatsRemaining: 1, capacity: 3 },
              { ...slot(NEXT), seatsRemaining: 3, capacity: 3 },
            ]}
            durationMinutes={30}
            timeZone="UTC"
            onTimeZoneChange={vi.fn()}
            locale={language}
            now={NOW}
            selected={null}
            onSelect={vi.fn()}
            version={0}
            initialPosition={{ month: { year: 2026, month: 11 }, day: '2026-11-02' }}
          />
        </EmbedLanguage>,
      )
      expect((await screen.findByText(one)).closest('button')?.disabled).toBe(false)
      expect(screen.getByText(many).closest('button')?.disabled).toBe(false)
    },
  )

  it.each(['en', 'zh-CN', 'fr'] as const)(
    'recovers from the last-seat race in %s without losing invitee details',
    async (language) => {
      const user = userEvent.setup()
      let taken = false
      const api = fakeApi({
        [`GET ${API}`]: () =>
          json(200, {
            ...EVENT,
            questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: true }],
          }),
        [`GET ${API}/slots`]: () =>
          json(200, {
            data: [
              ...(!taken ? [{ ...slot(START), seatsRemaining: 1, capacity: 2 }] : []),
              { ...slot(NEXT), seatsRemaining: 2, capacity: 2 },
            ],
          }),
        [`POST ${API}/bookings`]: () => {
          if (!taken) {
            taken = true
            return json(409, { error: 'slot_taken' })
          }
          return json(201, { booking: booking({ start: NEXT }), manageToken: TOKEN })
        },
      })
      renderApp('/ada/intro')
      await screen.findByRole('heading', { name: EVENT.title })
      if (language !== 'en') await selectPublicLanguage(user, language)
      await waitFor(() => expect(document.querySelector('.day-available')).not.toBeNull())
      fireEvent.click(document.querySelector('.day-available') as HTMLElement)
      await user.click(
        await screen.findByRole('button', {
          name: new RegExp(translate(language, '{count} seat left', { count: 1 })),
        }),
      )
      await user.type(screen.getByLabelText(translate(language, 'Your name')), 'Grace Hopper')
      await user.type(screen.getByLabelText(translate(language, 'Email')), 'grace@example.test')
      await user.type(screen.getByLabelText('Topic'), 'Compiler design')
      await user.click(screen.getByRole('button', { name: translate(language, 'Confirm booking') }))
      await screen.findByText(
        translate(language, 'Someone else just booked that time. Please pick another one.'),
      )
      await waitFor(() => expect(api.to(`GET ${API}/slots`)).toHaveLength(2))
      expect(screen.queryByText(translate(language, '{count} seat left', { count: 1 }))).toBeNull()
      await user.click(
        await screen.findByRole('button', {
          name: new RegExp(translate(language, '{count} seats left', { count: 2 })),
        }),
      )
      expect(screen.getByLabelText<HTMLInputElement>(translate(language, 'Your name')).value).toBe(
        'Grace Hopper',
      )
      expect(screen.getByLabelText<HTMLInputElement>(translate(language, 'Email')).value).toBe(
        'grace@example.test',
      )
      expect(screen.getByLabelText<HTMLInputElement>('Topic').value).toBe('Compiler design')
      await user.click(screen.getByRole('button', { name: translate(language, 'Confirm booking') }))
      await screen.findByRole('heading', { name: translate(language, 'You’re booked') })
      const posts = api.to(`POST ${API}/bookings`)
      expect(posts[1]?.body).toMatchObject({
        start: NEXT,
        responses: { topic: 'Compiler design' },
        invitee: { name: 'Grace Hopper', email: 'grace@example.test' },
      })
      expect(posts[1]?.headers.get('idempotency-key')).not.toBe(
        posts[0]?.headers.get('idempotency-key'),
      )
    },
  )

  it('shows counts and hides full sessions in the embed document shared by inline, popup and manual iframe modes, without adding booking data to messages', async () => {
    const postMessage = vi.fn()
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window)
    const path =
      '/embed/ada/intro?parentOrigin=https%3A%2F%2Fparent.example&embedId=abcdefghijklmnop1234'
    window.history.replaceState(null, '', path)
    let full = false
    fakeApi({
      [`GET ${API}`]: () => json(200, EVENT),
      [`GET ${API}/slots`]: () =>
        json(200, { data: full ? [] : [{ ...slot(START), seatsRemaining: 1, capacity: 2 }] }),
      [`POST ${API}/bookings`]: () => {
        full = true
        return json(201, { booking: booking(), manageToken: TOKEN })
      },
    })
    const user = userEvent.setup()
    const view = renderApp(path)
    await waitFor(() => expect(document.querySelector('.day-available')).not.toBeNull())
    fireEvent.click(document.querySelector('.day-available') as HTMLElement)
    await user.click(await screen.findByRole('button', { name: /1 seat left/ }))
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), 'grace@example.test')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    expect(postMessage.mock.calls.filter(([data]) => data.type === 'hourmere:booked')).toEqual([
      [{ type: 'hourmere:booked', id: 'abcdefghijklmnop1234' }, 'https://parent.example'],
    ])
    expect(JSON.stringify(postMessage.mock.calls)).not.toMatch(
      /Grace|grace@|manageToken|seatsRemaining|capacity/,
    )
    view.unmount()
    renderApp(path)
    await screen.findByText('No available times this month.')
    expect(document.querySelector('.slot')).toBeNull()
  })
})
