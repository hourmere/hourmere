import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../i18n/store.ts'
import { type Call, fakeApi, json, later, renderApp } from '../test/fake-api.tsx'
import { booking, EVENT, slot, slotsAnswer, TOKEN } from '../test/public-fixtures.ts'

const env = vi.hoisted(() => ({
  zone: 'America/New_York',
  now: Date.parse('2026-11-01T04:30:00Z'),
}))
vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  detectTimeZone: () => env.zone,
  preferredLocale: () => 'en-US',
  now: () => env.now,
}))

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

const translations = [
  ['en', 'Meeting length', '30 min', '1 h'],
  ['zh-CN', '会议时长', '30 分钟', '1 小时'],
  ['de', 'Termindauer', '30 Min.', '1 Std.'],
  ['fr', 'Durée de la réunion', '30 min', '1 h'],
  ['es', 'Duración de la reunión', '30 min', '1 h'],
  ['pt-BR', 'Duração da reunião', '30 min', '1 h'],
] as const
const firstStart = '2026-11-02T14:00:00Z'
const secondStart = '2026-11-02T15:00:00Z'

function routes(path: string, durations?: number[]) {
  const team = path.includes('/team/')
  const base = team ? '/api/v1/public/teams/example/intro' : '/api/v1/public/ada/intro'
  const event = {
    ...EVENT,
    ...(durations && { allowedDurationsMinutes: durations }),
    ...(team && { team: { name: 'Example team', slug: 'example' } }),
  }
  const book = (call: Call) => {
    const body = call.body as { start: string; durationMinutes?: number }
    return json(201, {
      booking: booking(slot(body.start, body.durationMinutes ?? 30)),
      manageToken: TOKEN,
    })
  }
  return {
    base,
    book,
    handlers: {
      [`GET ${base}`]: () => json(200, event),
      [`GET ${base}/slots`]: (call: Call) => {
        const duration = Number(new URL(call.path, 'http://x').searchParams.get('durationMinutes'))
        return slotsAnswer([duration === 60 ? secondStart : firstStart], duration || 30)(call)
      },
      [`POST ${base}/bookings`]: book,
    },
  }
}

async function chooseFirstTime(user: ReturnType<typeof userEvent.setup>) {
  const day = await waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-day="2026-11-02"]')
    expect(button?.disabled).toBe(false)
    return button as HTMLButtonElement
  })
  await user.click(day)
  const list = await screen.findByRole('list', { name: /^(Times on|.*的时间$)/ })
  await user.click(within(list).getAllByRole('button')[0] as HTMLElement)
}

describe('meeting length on public booking pages', () => {
  it.each(translations)(
    'labels the duration radios naturally in %s',
    async (language, label, halfHour, hour) => {
      chooseLanguage(language)
      const { handlers } = routes('/ada/intro', [30, 60])
      fakeApi(handlers)
      renderApp('/ada/intro')
      const group = await screen.findByRole('group', { name: label })
      expect(within(group).getByRole<HTMLInputElement>('radio', { name: halfHour }).checked).toBe(
        true,
      )
      expect(within(group).getByRole<HTMLInputElement>('radio', { name: hour }).checked).toBe(false)
    },
  )

  for (const path of [
    '/ada/intro',
    '/team/example/intro',
    '/embed/ada/intro',
    '/embed/team/example/intro',
  ]) {
    it.each(translations.slice(0, 2))(
      `selects with the keyboard and books the selected length in %s at ${path}`,
      async (language, label, halfHour, hour) => {
        const user = userEvent.setup()
        chooseLanguage(language)
        const { base, handlers } = routes(path, [15, 30, 60])
        const api = fakeApi(handlers)
        renderApp(path)
        const group = await screen.findByRole('group', { name: label })
        const initial = within(group).getByRole<HTMLInputElement>('radio', { name: halfHour })
        expect(initial.checked).toBe(true)
        await waitFor(() => expect(api.to(`GET ${base}/slots`)).toHaveLength(1))
        expect(
          new URL(api.to(`GET ${base}/slots`)[0]?.path ?? '', 'http://x').searchParams.get(
            'durationMinutes',
          ),
        ).toBe('30')
        expect(
          group.compareDocumentPosition(screen.getByRole('grid')) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy()
        initial.focus()
        await user.keyboard('{ArrowRight}')
        const selected = within(group).getByRole<HTMLInputElement>('radio', { name: hour })
        expect(document.activeElement).toBe(selected)
        expect(selected.checked).toBe(true)
        await waitFor(() => expect(api.to(`GET ${base}/slots`)).toHaveLength(2))
        const query = new URL(api.to(`GET ${base}/slots`)[1]?.path ?? '', 'http://x').searchParams
        expect(query.get('durationMinutes')).toBe('60')
        expect(query.get('end')).toBe('2026-12-01T15:00:00.000Z')
        await chooseFirstTime(user)
        await user.type(
          screen.getByLabelText(language === 'en' ? 'Your name' : '你的姓名'),
          'Grace Hopper',
        )
        await user.type(
          screen.getByLabelText(language === 'en' ? 'Email' : '邮箱'),
          'grace@example.invalid',
        )
        await user.click(
          screen.getByRole('button', { name: language === 'en' ? 'Confirm booking' : '确认预约' }),
        )
        await screen.findByRole('heading', {
          name: language === 'en' ? 'You’re booked' : '预约成功',
        })
        const sent = api.to(`POST ${base}/bookings`)[0]?.body
        expect(sent).toMatchObject({
          start: new Date(secondStart).toISOString(),
          durationMinutes: 60,
        })
        if (path.startsWith('/embed/')) expect(sent).toHaveProperty('source', 'embed')
        expect(screen.getByText(label).nextElementSibling?.textContent).toBe(hour)
        const ics = screen.getByRole('link', {
          name: language === 'en' ? 'Download .ics file' : '下载 .ics 文件',
        })
        expect(decodeURIComponent(ics.getAttribute('href') ?? '')).toContain(
          'DTSTART:20261102T150000Z\r\nDTEND:20261102T160000Z',
        )
        expect(document.querySelector('.confirmation')?.textContent).toMatch(/10:00.*11:00/)
      },
    )
  }

  it.each([undefined, [30]])(
    'keeps the single-duration flow unchanged with %j',
    async (durations) => {
      const user = userEvent.setup()
      const { base, handlers } = routes('/ada/intro', durations)
      const api = fakeApi(handlers)
      renderApp('/ada/intro')
      await screen.findByRole('heading', { name: 'Pick a time' })
      expect(screen.queryByRole('radio')).toBeNull()
      await chooseFirstTime(user)
      expect(
        new URL(api.to(`GET ${base}/slots`)[0]?.path ?? '', 'http://x').searchParams.has(
          'durationMinutes',
        ),
      ).toBe(false)
      await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
      await user.type(screen.getByLabelText('Email'), 'grace@example.invalid')
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      await screen.findByRole('heading', { name: 'You’re booked' })
      expect(api.to(`POST ${base}/bookings`)[0]?.body).not.toHaveProperty('durationMinutes')
      expect(screen.queryByText('Meeting length')).toBeNull()
    },
  )

  it('never shows stale slots while the selected duration loads', async () => {
    const user = userEvent.setup()
    const answer = later()
    const { base, handlers } = routes('/ada/intro', [30, 60])
    fakeApi({
      ...handlers,
      [`GET ${base}/slots`]: (call) =>
        new URL(call.path, 'http://x').searchParams.get('durationMinutes') === '60'
          ? answer.response
          : slotsAnswer([firstStart])(call),
    })
    renderApp('/ada/intro')
    await user.click(await screen.findByRole('button', { name: 'Monday, November 2, available' }))
    expect(screen.getByRole('button', { name: '9:00 AM' })).toBeDefined()
    await user.click(screen.getByRole('radio', { name: '1 h' }))
    expect(screen.queryByRole('button', { name: '9:00 AM' })).toBeNull()
    await answer.answer(json(200, { data: [slot(secondStart, 60)] }))
    expect(await screen.findByRole('button', { name: '10:00 AM' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '9:00 AM' })).toBeNull()
  })

  for (const path of [
    '/ada/intro',
    '/team/example/intro',
    '/embed/ada/intro',
    '/embed/team/example/intro',
  ]) {
    it.each([
      ['en', 'booking'],
      ['zh-CN', 'booking'],
      ['en', 'slots'],
      ['zh-CN', 'slots'],
    ] as const)(
      `refreshes changed lengths and slots in place while preserving the draft in %s after %s rejects at ${path}`,
      async (language, rejectedRequest) => {
        const user = userEvent.setup()
        chooseLanguage(language)
        const refresh = later()
        const { base, handlers, book } = routes(path, [30, 60])
        const questions = [
          { id: 'topic', label: 'Topic', type: 'short_text' as const, required: true },
        ]
        let eventLoads = 0
        let submissions = 0
        let hostChanged = false
        let rejectedSlots = false
        const rawMessage = 'durationMinutes must be one of allowedDurationsMinutes'
        const api = fakeApi({
          ...handlers,
          [`GET ${base}`]: () =>
            ++eventLoads === 1
              ? json(200, { ...EVENT, allowedDurationsMinutes: [30, 60], questions })
              : refresh.response,
          [`GET ${base}/slots`]: (call) => {
            if (hostChanged && rejectedRequest === 'slots' && !rejectedSlots) {
              rejectedSlots = true
              return json(400, { error: 'invalid_duration', message: rawMessage })
            }
            const duration = Number(
              new URL(call.path, 'http://x').searchParams.get('durationMinutes'),
            )
            return slotsAnswer([duration === 45 ? firstStart : secondStart], duration)(call)
          },
          [`POST ${base}/bookings`]: (call) =>
            ++submissions === 1 && rejectedRequest === 'booking'
              ? json(400, { error: 'invalid_duration', message: rawMessage })
              : book(call),
        })
        renderApp(path)
        await user.click(
          await screen.findByRole('radio', { name: language === 'en' ? '1 h' : '1 小时' }),
        )
        await chooseFirstTime(user)
        const nameLabel = language === 'en' ? 'Your name' : '你的姓名'
        const emailLabel = language === 'en' ? 'Email' : '邮箱'
        const confirmLabel = language === 'en' ? 'Confirm booking' : '确认预约'
        await user.type(screen.getByLabelText(nameLabel), 'Grace Hopper')
        await user.type(screen.getByLabelText(emailLabel), 'grace@example.invalid')
        await user.type(screen.getByLabelText('Topic'), 'Compiler design')
        await user.click(
          screen.getByRole('button', { name: language === 'en' ? 'Add a guest' : '添加来宾' }),
        )
        const guestName = language === 'en' ? 'Guest 1 name' : '来宾 1 的姓名'
        const guestEmail = language === 'en' ? 'Guest 1 email' : '来宾 1 的邮箱'
        await user.type(screen.getByLabelText(guestName), 'Alan Turing')
        await user.type(screen.getByLabelText(guestEmail), 'alan@example.invalid')
        hostChanged = true
        await user.click(
          screen.getByRole('button', {
            name:
              rejectedRequest === 'booking'
                ? confirmLabel
                : language === 'en'
                  ? 'Change time'
                  : '更改时间',
          }),
        )
        const notice =
          language === 'en'
            ? 'The available meeting lengths have changed. Please choose a length again.'
            : '可选的会议时长已更改。请重新选择时长。'
        await screen.findByText(notice)
        expect(document.body.textContent).not.toContain(rawMessage)
        expect(screen.queryByRole('radio')).toBeNull()
        expect(screen.queryByRole('grid')).toBeNull()
        expect(api.to(`GET ${base}`)).toHaveLength(2)
        const slotsBeforeRefresh = api.to(`GET ${base}/slots`).length
        await refresh.answer(
          json(200, {
            ...EVENT,
            durationMinutes: 45,
            allowedDurationsMinutes: [15, 45],
            questions,
          }),
        )
        const selected = await screen.findByRole<HTMLInputElement>('radio', {
          name: language === 'en' ? '45 min' : '45 分钟',
        })
        expect(selected.checked).toBe(true)
        expect(
          screen.queryByRole('radio', { name: language === 'en' ? '1 h' : '1 小时' }),
        ).toBeNull()
        await waitFor(() =>
          expect(api.to(`GET ${base}/slots`)).toHaveLength(slotsBeforeRefresh + 1),
        )
        expect(
          new URL(api.to(`GET ${base}/slots`).at(-1)?.path ?? '', 'http://x').searchParams.get(
            'durationMinutes',
          ),
        ).toBe('45')
        expect(document.body.textContent).not.toContain(rawMessage)
        await chooseFirstTime(user)
        expect(screen.getByLabelText<HTMLInputElement>(nameLabel).value).toBe('Grace Hopper')
        expect(screen.getByLabelText<HTMLInputElement>(emailLabel).value).toBe(
          'grace@example.invalid',
        )
        expect(screen.getByLabelText<HTMLInputElement>('Topic').value).toBe('Compiler design')
        expect(screen.getByLabelText<HTMLInputElement>(guestName).value).toBe('Alan Turing')
        expect(screen.getByLabelText<HTMLInputElement>(guestEmail).value).toBe(
          'alan@example.invalid',
        )
        await user.click(screen.getByRole('button', { name: confirmLabel }))
        await screen.findByRole('heading', {
          name: language === 'en' ? 'You’re booked' : '预约成功',
        })
        const calls = api.to(`POST ${base}/bookings`)
        expect(calls).toHaveLength(rejectedRequest === 'booking' ? 2 : 1)
        if (rejectedRequest === 'booking')
          expect(calls[1]?.headers.get('idempotency-key')).not.toBe(
            calls[0]?.headers.get('idempotency-key'),
          )
        expect(calls.at(-1)?.body).toMatchObject({
          start: new Date(firstStart).toISOString(),
          durationMinutes: 45,
          invitee: { name: 'Grace Hopper', email: 'grace@example.invalid', timeZone: env.zone },
          guests: [{ name: 'Alan Turing', email: 'alan@example.invalid' }],
          responses: { topic: 'Compiler design' },
        })
      },
    )
  }

  it('starts a fresh attempt even when the refreshed lengths and selected slot are unchanged', async () => {
    const user = userEvent.setup()
    const { base, handlers, book } = routes('/ada/intro', [30, 60])
    let submissions = 0
    const api = fakeApi({
      ...handlers,
      [`POST ${base}/bookings`]: (call) =>
        ++submissions === 1
          ? json(400, { error: 'invalid_duration', message: 'Raw engine message' })
          : book(call),
    })
    renderApp('/ada/intro')
    await chooseFirstTime(user)
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), 'grace@example.invalid')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByText(
      'The available meeting lengths have changed. Please choose a length again.',
    )
    await chooseFirstTime(user)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    const calls = api.to(`POST ${base}/bookings`)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.headers.get('idempotency-key')).not.toBe(
      calls[0]?.headers.get('idempotency-key'),
    )
    expect(calls[1]?.body).toEqual(calls[0]?.body)
    expect(api.to(`GET ${base}`)).toHaveLength(2)
    expect(api.to(`GET ${base}/slots`)).toHaveLength(2)
  })

  it('retries a failed lengths refresh without resubmitting stale details and recovers to a singleton', async () => {
    const user = userEvent.setup()
    const { base, handlers } = routes('/ada/intro', [30, 60])
    let eventLoads = 0
    const api = fakeApi({
      ...handlers,
      [`GET ${base}`]: () => {
        eventLoads += 1
        if (eventLoads === 1) return json(200, { ...EVENT, allowedDurationsMinutes: [30, 60] })
        if (eventLoads === 2) throw new TypeError('Failed to fetch')
        return json(200, { ...EVENT, durationMinutes: 45 })
      },
      [`GET ${base}/slots`]: slotsAnswer([firstStart], 45),
      [`POST ${base}/bookings`]: () =>
        json(400, { error: 'invalid_duration', message: 'Raw engine message' }),
    })
    renderApp('/ada/intro')
    await chooseFirstTime(user)
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), 'grace@example.invalid')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('button', { name: 'Try again' })
    expect(screen.getByRole('alert').textContent).toMatch(/reach|connection/i)
    expect(document.body.textContent).not.toContain('Raw engine message')
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('grid')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await chooseFirstTime(user)
    expect(api.to(`GET ${base}`)).toHaveLength(3)
    expect(api.to(`POST ${base}/bookings`)).toHaveLength(1)
    expect(
      new URL(api.to(`GET ${base}/slots`).at(-1)?.path ?? '', 'http://x').searchParams.has(
        'durationMinutes',
      ),
    ).toBe(false)
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>('Your name').value).toBe('Grace Hopper')
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe('grace@example.invalid')
  })

  it('starts a new idempotent attempt after changing duration and returning to the original length', async () => {
    const user = userEvent.setup()
    const { base, handlers } = routes('/ada/intro', [30, 60])
    const api = fakeApi({
      ...handlers,
      [`GET ${base}/slots`]: (call) =>
        slotsAnswer(
          [firstStart],
          Number(new URL(call.path, 'http://x').searchParams.get('durationMinutes')),
        )(call),
      [`POST ${base}/bookings`]: () => {
        throw new TypeError('Failed to fetch')
      },
    })
    renderApp('/ada/intro')
    await chooseFirstTime(user)
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), 'grace@example.invalid')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByText(/Your booking is not confirmed yet/)
    await user.click(screen.getByRole('button', { name: 'Change time' }))
    await user.click(screen.getByRole('radio', { name: '1 h' }))
    await waitFor(() => expect(api.to(`GET ${base}/slots`)).toHaveLength(3))
    await user.click(screen.getByRole('radio', { name: '30 min' }))
    await chooseFirstTime(user)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByText(/Your booking is not confirmed yet/)
    const calls = api.to(`POST ${base}/bookings`)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.headers.get('idempotency-key')).not.toBe(
      calls[0]?.headers.get('idempotency-key'),
    )
    expect(calls[1]?.body).toMatchObject({
      start: new Date(firstStart).toISOString(),
      durationMinutes: 30,
    })
    expect(screen.getByLabelText<HTMLInputElement>('Your name').value).toBe('Grace Hopper')
  })
})
