import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeApi, json, later, renderApp } from '../test/fake-api.tsx'
import { expectStackGap } from '../test/layout.ts'
import {
  ALL_QUESTIONS,
  booking,
  EVENT,
  eventRoutes,
  managed,
  slot,
  slotsAnswer,
  TOKEN,
} from '../test/public-fixtures.ts'

// The visitor's zone, language and clock, as the browser would report them.
const env = vi.hoisted(() => ({
  zone: 'America/New_York',
  locale: 'en-US',
  now: Date.parse('2026-11-01T04:30:00Z'), // 00:30 EDT on Sunday, November 1
}))
vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  detectTimeZone: () => env.zone,
  preferredLocale: () => env.locale,
  now: () => env.now,
}))

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  env.zone = 'America/New_York'
  env.locale = 'en-US'
  env.now = Date.parse('2026-11-01T04:30:00Z')
})

/** Narrow no-break spaces from Intl ("9:00 AM") as plain spaces. */
const plain = (text: string | null | undefined) =>
  (text ?? '').replace(/[\u2009\u202f\u00a0]/g, ' ')
const slotButtons = () =>
  within(screen.getByRole('list', { name: /^Times on/ }))
    .getAllByRole('button')
    .map((b) => plain(b.textContent))
const day = (name: RegExp | string) => screen.findByRole('button', { name })

// New York falls back from EDT to EST at 02:00 on November 1, 2026.
const DST_SLOTS = [
  '2026-11-01T05:30:00Z', // 01:30 EDT
  '2026-11-01T06:30:00Z', // 01:30 EST, the same wall time an hour later
  '2026-11-02T14:00:00Z', // 09:00 EST on Monday the 2nd
  '2026-11-03T03:30:00Z', // 22:30 EST on Monday the 2nd (already the 3rd in UTC)
  '2026-11-02T10:30:00Z', // 05:30 EST on the 2nd; 00:30 on the 3rd at UTC+14
]

async function chooseSlot(user: ReturnType<typeof userEvent.setup>, dayName: RegExp, time: string) {
  await user.click(await day(dayName))
  await user.click(screen.getByRole('button', { name: time }))
}

describe('the booking page', () => {
  it.each(['Change time', 'conflict'])(
    'restores the month, day, time zone and complete draft after returning through %s',
    async (back) => {
      const user = userEvent.setup()
      const starts = ['2026-11-03T15:00:00Z', '2026-12-08T15:00:00Z', '2026-12-08T16:00:00Z']
      let taken = false
      const api = fakeApi({
        ...eventRoutes({ ...EVENT, questions: ALL_QUESTIONS }, starts),
        'GET /api/v1/public/ada/intro/slots': (call) =>
          slotsAnswer(taken ? starts.filter((start) => start !== starts[1]) : starts)(call),
        'POST /api/v1/public/ada/intro/bookings': () => {
          taken = true
          return json(409, { error: 'slot_taken' })
        },
      })
      renderApp('/ada/intro')
      await day('Tuesday, November 3, available')
      await user.click(screen.getByRole('button', { name: 'Next month' }))
      await user.click(screen.getByRole('button', { name: /Time zone/ }))
      await user.type(screen.getByRole('combobox', { name: 'Search time zones' }), 'utc')
      await user.keyboard('{Enter}')
      await chooseSlot(user, /December 8, available/, '3:00 PM')
      await user.type(screen.getByLabelText('Your name'), 'Synthetic Visitor')
      await user.type(screen.getByLabelText('Email'), 'synthetic@example.invalid')
      await user.type(screen.getByLabelText('Topic'), 'Compilers')
      await user.type(screen.getByLabelText(/Anything else\?/), 'Keep this draft\nfor later')
      await user.type(screen.getByLabelText(/Phone/), '+1 202 555 0123')
      await user.selectOptions(screen.getByLabelText('Team size'), '11+')
      await user.click(screen.getByLabelText('MCP'))
      await user.click(screen.getByLabelText('I agree to the terms'))
      await user.click(screen.getByRole('button', { name: 'Add a guest' }))
      await user.type(screen.getByLabelText('Guest 1 name'), 'Synthetic Guest')
      await user.type(screen.getByLabelText('Guest 1 email'), 'guest@example.invalid')
      await user.click(
        screen.getByRole('button', { name: back === 'conflict' ? 'Confirm booking' : back }),
      )

      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Pick a time' })),
      )
      const restored = await day('Tuesday, December 8, available')
      expect(screen.getByRole('heading', { name: 'December 2026' })).toBeDefined()
      expect(restored.closest('td')?.getAttribute('aria-selected')).toBe('true')
      expect(screen.getByRole('button', { name: /Time zone/ }).textContent).toContain('UTC')
      expect(slotButtons()).toEqual(back === 'conflict' ? ['4:00 PM'] : ['3:00 PM', '4:00 PM'])
      expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
      expect(document.querySelector('.chosen-time')).toBeNull()
      await waitFor(() => expect(api.to('GET /api/v1/public/ada/intro/slots')).toHaveLength(3))
      const lastQuery = new URL(
        api.to('GET /api/v1/public/ada/intro/slots')[2]?.path ?? '',
        'http://x',
      ).searchParams
      expect(lastQuery.get('start')).toBe('2026-11-30T09:30:00.000Z')
      expect(api.to('POST /api/v1/public/ada/intro/bookings')).toHaveLength(
        back === 'conflict' ? 1 : 0,
      )
      if (back === 'conflict') {
        expect(screen.getByRole('alert').textContent).toBe(
          'Someone else just booked that time. Please pick another one.',
        )
      }
      await user.click(screen.getByRole('button', { name: '4:00 PM' }))
      expect(screen.getByLabelText<HTMLInputElement>('Your name').value).toBe('Synthetic Visitor')
      expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe(
        'synthetic@example.invalid',
      )
      expect(screen.getByLabelText<HTMLInputElement>('Topic').value).toBe('Compilers')
      expect(screen.getByLabelText<HTMLTextAreaElement>(/Anything else\?/).value).toBe(
        'Keep this draft\nfor later',
      )
      expect(screen.getByLabelText<HTMLInputElement>(/Phone/).value).toBe('+1 202 555 0123')
      expect(screen.getByLabelText<HTMLSelectElement>('Team size').value).toBe('11+')
      expect(screen.getByLabelText<HTMLInputElement>('MCP').checked).toBe(true)
      expect(screen.getByLabelText<HTMLInputElement>('I agree to the terms').checked).toBe(true)
      expect(screen.getByLabelText<HTMLInputElement>('Guest 1 name').value).toBe('Synthetic Guest')
      expect(screen.getByLabelText<HTMLInputElement>('Guest 1 email').value).toBe(
        'guest@example.invalid',
      )
      expect(document.querySelector('.chosen-time .muted')?.textContent).toContain('UTC')
      expect(api.to('POST /api/v1/public/ada/intro/bookings')).toHaveLength(
        back === 'conflict' ? 1 : 0,
      )
    },
  )

  it('keeps retry identity across language changes and resets it when another time is chosen', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const starts = ['2026-11-03T15:00:00Z', '2026-12-08T15:00:00Z', '2026-12-08T16:00:00Z']
    const api = fakeApi({
      ...eventRoutes(EVENT, starts),
      'POST /api/v1/public/ada/intro/bookings': () => {
        if (++attempts < 4) throw new TypeError('Failed to fetch')
        return json(201, { booking: booking(), manageToken: TOKEN })
      },
    })
    renderApp('/ada/intro')
    await day('Tuesday, November 3, available')
    await user.click(screen.getByRole('button', { name: 'Next month' }))
    await chooseSlot(user, /December 8, available/, '10:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Synthetic Visitor')
    await user.type(screen.getByLabelText('Email'), 'synthetic@example.invalid')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByText(/Your booking is not confirmed yet/)
    await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(screen.getByLabelText<HTMLInputElement>('你的姓名').value).toBe('Synthetic Visitor')
    await user.click(screen.getByRole('button', { name: '确认预约' }))
    await screen.findByText(/你的预约尚未确认/)

    // Browsing back to the same time still retries the unchanged request.
    await user.click(screen.getByRole('button', { name: '更改时间' }))
    const restored = await waitFor(() => {
      const selected = document.querySelector('[data-day="2026-12-08"]')
      expect(selected?.closest('td')?.getAttribute('aria-selected')).toBe('true')
      expect(screen.getByRole('list', { name: /的时间$/ })).toBeDefined()
      return selected
    })
    expect(restored).not.toBeNull()
    expect(screen.getByRole('heading', { name: '2026年12月' })).toBeDefined()
    const chooseTime = (index: number) =>
      user.click(
        within(screen.getByRole('list', { name: /的时间$/ })).getAllByRole('button')[
          index
        ] as HTMLElement,
      )
    await chooseTime(0)
    await user.click(screen.getByRole('button', { name: '确认预约' }))
    await screen.findByText(/你的预约尚未确认/)
    const retries = api.to('POST /api/v1/public/ada/intro/bookings')
    expect(retries).toHaveLength(3)
    const key = retries[0]?.headers.get('idempotency-key')
    expect(key).toBeTruthy()
    for (const retry of retries.slice(1)) {
      expect(retry.headers.get('idempotency-key')).toBe(key)
      expect(retry.body).toEqual(retries[0]?.body)
    }
    expect(retries[0]?.body).toHaveProperty('invitee.locale', 'en-US')

    // Choosing another time ends that attempt, even if the visitor then returns to it.
    await user.click(screen.getByRole('button', { name: '更改时间' }))
    await screen.findByRole('list', { name: /的时间$/ })
    await chooseTime(1)
    expect(screen.getByLabelText<HTMLInputElement>('邮箱').value).toBe('synthetic@example.invalid')
    await user.click(screen.getByRole('button', { name: '更改时间' }))
    await screen.findByRole('list', { name: /的时间$/ })
    await chooseTime(0)
    expect(api.to('POST /api/v1/public/ada/intro/bookings')).toHaveLength(3)
    await user.click(screen.getByRole('button', { name: '确认预约' }))
    await screen.findByRole('heading', { name: '预约成功' })
    const posts = api.to('POST /api/v1/public/ada/intro/bookings')
    expect(posts).toHaveLength(4)
    expect(posts[3]?.headers.get('idempotency-key')).not.toBe(key)
    expect(posts[3]?.body).toMatchObject({
      start: '2026-12-08T15:00:00.000Z',
      invitee: {
        name: 'Synthetic Visitor',
        email: 'synthetic@example.invalid',
        locale: 'zh-CN',
      },
    })
  })

  it('keeps the selected time fixed and sends one request while submission is pending', async () => {
    const user = userEvent.setup()
    const pending = later()
    const api = fakeApi({
      ...eventRoutes(EVENT, DST_SLOTS),
      'POST /api/v1/public/ada/intro/bookings': () => pending.response,
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Synthetic Visitor')
    await user.type(screen.getByLabelText('Email'), 'synthetic@example.invalid')
    const form = screen.getByRole('button', { name: 'Confirm booking' }).closest('form')
    const change = screen.getByRole<HTMLButtonElement>('button', { name: 'Change time' })
    expect(form).not.toBeNull()
    act(() => {
      fireEvent.submit(form as HTMLFormElement)
      fireEvent.submit(form as HTMLFormElement)
      fireEvent.click(change)
    })
    await waitFor(() => expect(api.to('POST /api/v1/public/ada/intro/bookings')).toHaveLength(1))
    expect(change.disabled).toBe(true)
    await user.click(change)
    expect(screen.getByRole('heading', { name: 'Your details' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Pick a time' })).toBeNull()
    await pending.answer(json(409, { error: 'slot_taken' }))
    await screen.findByRole('heading', { name: 'Pick a time' })
    expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
    expect(api.to('POST /api/v1/public/ada/intro/bookings')).toHaveLength(1)
  })

  it('discards visitor details when the booking page is mounted again', async () => {
    const user = userEvent.setup()
    const api = fakeApi(eventRoutes({ ...EVENT, questions: ALL_QUESTIONS }, DST_SLOTS))
    const page = renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Synthetic Visitor')
    await user.type(screen.getByLabelText('Email'), 'synthetic@example.invalid')
    await user.type(screen.getByLabelText('Topic'), 'Private draft')
    await user.click(screen.getByRole('button', { name: 'Add a guest' }))
    await user.type(screen.getByLabelText('Guest 1 email'), 'guest@example.invalid')
    page.unmount()

    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    expect(screen.getByLabelText<HTMLInputElement>('Your name').value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>('Topic').value).toBe('')
    expect(screen.queryByLabelText('Guest 1 email')).toBeNull()
    expect(api.to('POST /api/v1/public/ada/intro/bookings')).toHaveLength(0)
  })

  it.each(['Change time', 'conflict'])(
    'rechecks the current time when returning through %s',
    async (back) => {
      const user = userEvent.setup()
      fakeApi({
        ...eventRoutes(EVENT, [
          '2026-11-03T15:00:00Z',
          '2026-12-08T15:00:00Z',
          '2026-12-09T15:00:00Z',
        ]),
        'POST /api/v1/public/ada/intro/bookings': () => json(409, { error: 'slot_taken' }),
      })
      renderApp('/ada/intro')
      await day('Tuesday, November 3, available')
      await user.click(screen.getByRole('button', { name: 'Next month' }))
      await chooseSlot(user, /December 8, available/, '10:00 AM')
      if (back === 'conflict') {
        await user.type(screen.getByLabelText('Your name'), 'Synthetic Visitor')
        await user.type(screen.getByLabelText('Email'), 'synthetic@example.invalid')
      }
      env.now = Date.parse('2026-12-08T15:05:00Z')
      await user.click(
        screen.getByRole('button', { name: back === 'conflict' ? 'Confirm booking' : back }),
      )
      const expired = await day('Tuesday, December 8, no times available')
      expect(expired.getAttribute('aria-disabled')).toBe('true')
      await waitFor(() => {
        expect(expired.closest('td')?.getAttribute('aria-selected')).toBe('false')
        expect(screen.queryByRole('list', { name: /^Times on/ })).toBeNull()
      })
      expect(await day('Wednesday, December 9, available')).toBeDefined()
    },
  )

  it.each([
    ['en', 'America/New York (GMT-05:00)', 'GMT-05:00)', ' ('],
    ['zh-CN', 'America/New York（GMT-05:00）', 'GMT-05:00）', '（'],
  ])(
    'localizes chosen-time offset brackets in %s without breaking the offset',
    async (language, expected, offset, prefix) => {
      const user = userEvent.setup()
      fakeApi(eventRoutes(EVENT, DST_SLOTS))
      renderApp('/ada/intro')
      await chooseSlot(user, /November 2, available/, '9:00 AM')
      await user.selectOptions(screen.getByLabelText('Interface language'), language)
      const zone = document.querySelector('.chosen-time .muted')
      expect(zone?.textContent).toBe(expected)
      const offsetSpan = zone?.querySelector('.time-offset')
      expect(offsetSpan?.textContent).toBe(offset)
      // Keep the English ASCII space breakable and the opening bracket outside the span.
      expect(offsetSpan?.previousSibling?.textContent?.endsWith(prefix)).toBe(true)
    },
  )

  it.each([
    {
      host: '主持人（王小明）',
      title: 'Intro call',
      lede: '你与主持人（王小明）的“Intro call”预约已确认。',
      calendar: '与主持人（王小明）的 Intro call',
    },
    {
      host: 'Ada Lovelace',
      title: 'Intro call',
      lede: '你与 Ada Lovelace 的“Intro call”预约已确认。',
      calendar: '与 Ada Lovelace 的 Intro call',
    },
    {
      host: 'O’Brien',
      title: 'Ada’s review',
      lede: '你与 O’Brien 的“Ada’s review”预约已确认。',
      calendar: '与 O’Brien 的 Ada’s review',
    },
  ])(
    'localizes confirmation names and lists for $host and $title',
    async ({ host, title, lede, calendar }) => {
      const user = userEvent.setup()
      const data = booking()
      const event = {
        ...EVENT,
        title,
        host: { ...EVENT.host, name: host },
        hosts: [
          { name: '王小明', timeZone: 'Europe/Berlin' },
          { name: '李小红', timeZone: 'Asia/Shanghai' },
        ],
      }
      fakeApi({
        ...eventRoutes(event, DST_SLOTS),
        'POST /api/v1/public/ada/intro/bookings': () =>
          json(201, {
            booking: {
              ...data,
              attendees: [
                ...data.attendees,
                {
                  ...{ timeZone: 'America/New_York', locale: 'en-US' },
                  name: '周小刚',
                  email: 'guest1@example.invalid',
                  isBooker: false,
                },
                {
                  ...{ timeZone: 'America/New_York', locale: 'en-US' },
                  name: '赵小华',
                  email: 'guest2@example.invalid',
                  isBooker: false,
                },
              ],
            },
            manageToken: TOKEN,
          }),
      })
      renderApp('/ada/intro')
      await chooseSlot(user, /November 2, available/, '9:00 AM')
      await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
      await user.type(screen.getByLabelText('Email'), 'grace@example.com')
      await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
      expect(
        screen.getByText('必选主持人：王小明（Europe/Berlin）、李小红（Asia/Shanghai）'),
      ).toBeDefined()
      await user.click(screen.getByRole('button', { name: '确认预约' }))
      await screen.findByRole('heading', { name: '预约成功' })
      expect(document.querySelector('.confirmation .lede')?.textContent).toBe(lede)
      // Only the Chinese double quotes get quote markup; apostrophes in Latin text do not.
      expect(
        [
          ...(document.querySelector('.confirmation .lede')?.querySelectorAll('.cjk-quote') ?? []),
        ].map((span) => span.textContent),
      ).toEqual(['“', '”'])
      expect(screen.getByText('周小刚、赵小华')).toBeDefined()
      expect(screen.getByText('Grace Hopper（grace@example.com）')).toBeDefined()
      const calendarUrl = new URL(
        screen.getByRole<HTMLAnchorElement>('link', { name: 'Google 日历' }).href,
      )
      expect(calendarUrl.searchParams.get('text')).toBe(calendar)
      expect(document.querySelector('.manage-link p')?.textContent).toBe(
        '使用此链接改期或取消。此链接仅在此页面显示一次；持有链接的任何人都可更改你的预约，请妥善保管。',
      )
    },
  )

  it.each([
    ['en', 'You’re booked', 'When', 'Where', 'Host', 'Add to your calendar', 'Outlook'],
    ['zh-CN', '预约成功', '时间', '地点', '主持人', '添加到日历', 'Outlook'],
  ])(
    'puts event facts and calendar actions before supporting details in %s',
    async (language, result, when, where, host, calendar, outlook) => {
      const user = userEvent.setup()
      const data = booking()
      fakeApi({
        ...eventRoutes(EVENT, DST_SLOTS),
        'POST /api/v1/public/ada/intro/bookings': () =>
          json(201, {
            booking: {
              ...data,
              attendees: [
                ...data.attendees,
                {
                  name: 'A guest with a long display name / 名字较长的来宾',
                  email: 'guest@example.invalid',
                  timeZone: 'Asia/Shanghai',
                  locale: 'zh-CN',
                  isBooker: false,
                },
              ],
            },
            manageToken: TOKEN,
          }),
      })
      renderApp('/ada/intro')
      await chooseSlot(user, /November 2, available/, '9:00 AM')
      await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
      await user.type(screen.getByLabelText('Email'), 'grace@example.com')
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      await screen.findByRole('heading', { name: 'You’re booked' })
      await user.selectOptions(screen.getByLabelText('Interface language'), language)

      const ordered = [
        screen.getByRole('heading', { name: result }),
        screen.getByText(when, { selector: 'dt' }),
        screen.getByText(where, { selector: 'dt' }),
        screen.getByRole('heading', { name: calendar }),
        screen.getByText(host, { selector: 'dt' }),
        screen.getByRole('heading', {
          name:
            language === 'en' ? 'Save your link to change or cancel' : '保存用于更改或取消的链接',
        }),
        screen.getByText(
          language === 'en'
            ? 'Didn’t get the email? Check spam or junk and add the sender to your contacts.'
            : '没收到邮件？请检查垃圾邮件文件夹，并将发件人加入通讯录。',
        ),
      ]
      for (const [index, element] of ordered.entries()) {
        const next = ordered[index + 1]
        if (next)
          expect(
            element.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy()
      }
      // After the primary calendar actions, keyboard navigation reaches the private link.
      screen.getByRole('link', { name: outlook }).focus()
      await user.tab()
      const link = screen.getByRole('textbox') as HTMLInputElement
      expect(document.activeElement).toBe(link)
      expect(link.value).toBe(`${window.location.origin}/booking#token=${TOKEN}`)
      expect(screen.getByText('A guest with a long display name / 名字较长的来宾')).toBeDefined()
    },
  )

  it('explains calendar responses and opens cancellation with the existing private capability', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...eventRoutes(EVENT, DST_SLOTS),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, { booking: booking(), manageToken: TOKEN }),
      'GET /api/v1/bookings/manage': () => json(200, managed()),
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), 'grace@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    expect(document.querySelector('.confirmation-indicator')?.textContent).toBe('✓')
    expect(document.querySelector('.confirmation-indicator')?.getAttribute('aria-hidden')).toBe(
      'true',
    )
    const note = screen.getByText(
      'Accepting or declining the calendar invitation does not cancel the booking. To cancel, use “Cancel booking” here.',
    )
    const cancel = within(note.parentElement as HTMLElement).getByRole('link', {
      name: 'Cancel booking',
    })
    const calendar = screen.getByRole('heading', { name: 'Add to your calendar' }).parentElement
    expect(calendar?.nextElementSibling).toBe(note.parentElement?.parentElement)
    expectStackGap(note.parentElement?.parentElement as HTMLElement)
    expect(cancel.getAttribute('href')).toBe(`/booking#token=${TOKEN}&action=cancel`)
    expect(cancel.getAttribute('target')).toBeNull()
    for (const link of document.querySelectorAll('.calendar-links a')) {
      expect(decodeURIComponent(link.getAttribute('href') ?? '')).not.toContain(TOKEN)
    }
    await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent ===
            '在日历中接受或拒绝邀请不会取消预约。如需取消，请使用此处的“取消预约”。',
      ),
    ).toBeDefined()
    await user.click(screen.getByRole('link', { name: '取消预约' }))
    expect(await screen.findByRole('heading', { name: '取消此预约？' })).toBeDefined()
    expect(api.to('GET /api/v1/bookings/manage')[0]?.headers.get('x-manage-token')).toBe(TOKEN)
    expect(api.to('POST /api/v1/bookings/manage/cancel')).toHaveLength(0)
    expect(api.calls.every((call) => !call.path.includes(TOKEN))).toBe(true)
    expect(screen.getByTestId('location').textContent).toBe('/booking')
  })

  it.each(['cancelled', 'started'] as const)(
    'does not offer calendar cancellation advice for a %s booking',
    async (state) => {
      const user = userEvent.setup()
      fakeApi({
        ...eventRoutes(EVENT, DST_SLOTS),
        'POST /api/v1/public/ada/intro/bookings': () =>
          json(200, {
            booking: booking(
              state === 'cancelled'
                ? { status: 'cancelled' }
                : { start: '2026-10-01T14:00:00Z', end: '2026-10-01T14:30:00Z' },
            ),
            manageToken: null,
          }),
      })
      renderApp('/ada/intro')
      await chooseSlot(user, /November 2, available/, '9:00 AM')
      await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
      await user.type(screen.getByLabelText('Email'), 'grace@example.com')
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      await screen.findByRole('heading', {
        name: state === 'cancelled' ? 'Cancelled booking' : 'Ended',
      })
      expect(
        screen.queryByText(/Accepting or declining the calendar invitation does not cancel/),
      ).toBeNull()
      expect(screen.queryByRole('link', { name: 'Cancel booking' })).toBeNull()
      expect(screen.getByText(/Use the link in your confirmation email instead/)).toBeDefined()
      expect(document.querySelectorAll('.confirmation .alert-info')).toHaveLength(1)
      if (state === 'cancelled')
        expect(screen.queryByRole('heading', { name: 'Add to your calendar' })).toBeNull()
      else expect(screen.getByRole('heading', { name: 'Add to your calendar' })).toBeDefined()
    },
  )

  it.each(['pending', 'failed'] as const)(
    'keeps calendar cancellation advice consistent with a %s meeting-link heading',
    async (status) => {
      const user = userEvent.setup()
      const reserved = booking({
        location: { kind: 'google_meet', autoCreate: true },
        conference: {
          provider: 'google_meet',
          status,
          errorCode: status === 'failed' ? 'provider_unavailable' : null,
        },
      })
      fakeApi({
        ...eventRoutes(EVENT, DST_SLOTS),
        'POST /api/v1/public/ada/intro/bookings': () =>
          json(201, { booking: reserved, manageToken: TOKEN }),
        'GET /api/v1/bookings/manage': () => json(200, reserved),
      })
      renderApp('/ada/intro')
      await chooseSlot(user, /November 2, available/, '9:00 AM')
      await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
      await user.type(screen.getByLabelText('Email'), 'grace@example.com')
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      await screen.findByRole('heading', {
        name:
          status === 'pending'
            ? 'Time reserved; meeting link pending'
            : 'Time reserved; meeting link needs attention',
      })
      expect(
        screen.getByText(
          'Accepting or declining the calendar invitation does not cancel the booking. To cancel, use “Cancel booking” here.',
        ),
      ).toBeDefined()
      expect(screen.queryByText(/^Booking confirmed\./)).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Add to your calendar' })).toBeNull()
      expect(screen.getByLabelText('Your link to change or cancel this booking')).toBeDefined()
      await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
      expect(
        screen.getByText(
          (_, element) =>
            element?.tagName === 'P' &&
            element.textContent ===
              '在日历中接受或拒绝邀请不会取消预约。如需取消，请使用此处的“取消预约”。',
        ),
      ).toBeDefined()
      expect(screen.queryByText(/^预约已确认。/)).toBeNull()
    },
  )

  it('updates every zone offset for the selected date across DST while preserving slot instants', async () => {
    const user = userEvent.setup()
    env.zone = 'Europe/London'
    env.now = Date.parse('2026-10-19T08:00:00Z')
    const api = fakeApi({
      ...eventRoutes(EVENT, ['2026-10-20T09:00:00Z', '2026-10-27T09:00:00Z']),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, { booking: booking(), manageToken: TOKEN }),
    })
    renderApp('/ada/intro')
    const toggle = await screen.findByRole('button', { name: /Time zone/ })
    expect(toggle.textContent).toContain('GMT+01:00')
    await user.click(await day(/October 27, available/))
    expect(toggle.textContent).toContain('GMT+00:00')
    expect(slotButtons()).toEqual(['9:00 AM'])
    await user.click(toggle)
    const search = screen.getByRole('combobox', { name: 'Search time zones' })
    await user.type(search, 'london')
    const zones = within(screen.getByRole('listbox', { name: 'Time zones' }))
    expect(zones.getByRole('option').textContent).toBe('Europe/LondonGMT+00:00')
    await user.clear(search)
    await user.type(search, 'berlin')
    expect(zones.getByRole('option').textContent).toBe('Europe/BerlinGMT+01:00')
    await user.click(zones.getByRole('option'))
    expect(slotButtons()).toEqual(['10:00 AM'])
    await user.click(await day(/October 20, available/))
    expect(toggle.textContent).toContain('GMT+02:00')
    await user.click(await day(/October 27, available/))
    expect(toggle.textContent).toContain('GMT+01:00')
    expect(api.to('GET /api/v1/public/ada/intro/slots')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '10:00 AM' }))
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), 'grace@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    expect(
      screen.getByText(
        'Didn’t get the email? Check spam or junk and add the sender to your contacts.',
      ),
    ).toBeDefined()
    expect(api.to('POST /api/v1/public/ada/intro/bookings')[0]?.body).toMatchObject({
      start: '2026-10-27T09:00:00.000Z',
      invitee: { timeZone: 'Europe/Berlin' },
    })
  })

  it('uses the visible month when paging without a selected day', async () => {
    const user = userEvent.setup()
    env.zone = 'Europe/London'
    env.now = Date.parse('2026-10-19T08:00:00Z')
    fakeApi(eventRoutes(EVENT, ['2026-10-20T09:00:00Z', '2026-11-02T09:00:00Z']))
    renderApp('/ada/intro')
    const toggle = await screen.findByRole('button', { name: /Time zone/ })
    expect(toggle.textContent).toContain('GMT+01:00')
    await user.click(screen.getByRole('button', { name: 'Next month' }))
    await screen.findByRole('heading', { name: 'November 2026' })
    expect(toggle.textContent).toContain('GMT+00:00')
    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(toggle.textContent).toContain('GMT+01:00')
  })

  it('keeps unobtrusive attribution on ordinary booking pages, pointing to the hosted service', async () => {
    fakeApi(eventRoutes(EVENT, DST_SLOTS))
    renderApp('/ada/intro')
    await screen.findByRole('heading', { name: 'Intro call' })
    const mark = screen.getByRole('link', { name: /Powered by Hourmere/ })
    expect(mark.getAttribute('href')).toBe('https://hourmere.com')
    expect(mark.closest('footer')).not.toBeNull()
    expect(mark.getAttribute('target')).toBe('_blank')
    expect(mark.getAttribute('rel')).toContain('noreferrer')
    expect(screen.queryByRole('link', { name: 'Create your own booking link' })).toBeNull()
    expect(screen.queryByText(/Didn’t get the email/)).toBeNull()
  })

  it('uses the configured hosted destination for attribution and the confirmation CTA without sharing booking data', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...eventRoutes(EVENT, DST_SLOTS),
      'GET /api/v1/instance': () =>
        json(200, {
          hostedSignupUrl: 'https://hosted.example/sign-up',
          signIn: { email: true, google: false, microsoft: false },
        }),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, { booking: booking(), manageToken: TOKEN }),
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), 'grace@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    for (const name of [/Powered by Hourmere/, 'Create your own booking link']) {
      const link = screen.getByRole('link', { name })
      await waitFor(() => expect(link.getAttribute('href')).toBe('https://hosted.example/sign-up'))
      expect(link.getAttribute('rel')).toContain('noreferrer')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.classList.contains('button')).toBe(false)
      expect(link.tabIndex).toBe(0)
    }
    expect(
      screen
        .getByLabelText<HTMLInputElement>(/Your link to change or cancel/)
        .value.endsWith(TOKEN),
    ).toBe(true)
  })

  it('keeps the official attribution destination when instance discovery fails', async () => {
    fakeApi({
      ...eventRoutes(EVENT, DST_SLOTS),
      'GET /api/v1/instance': () => json(503, { error: 'internal_error' }),
    })
    renderApp('/ada/intro')
    await screen.findByRole('heading', { name: 'Intro call' })
    expect(screen.getByRole('link', { name: /Powered by Hourmere/ }).getAttribute('href')).toBe(
      'https://hourmere.com',
    )
  })

  it('withholds every calendar export until the protected Meet status becomes ready', async () => {
    const user = userEvent.setup(),
      JOIN = 'https://meet.google.com/abc-defg-hij'
    const pending = booking({
      location: { kind: 'google_meet', autoCreate: true },
      conference: { provider: 'google_meet', status: 'pending', errorCode: null },
    })
    const api = fakeApi({
      ...eventRoutes({ ...EVENT, location: { kind: 'google_meet' } }, DST_SLOTS),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, { booking: pending, manageToken: TOKEN }),
      'GET /api/v1/bookings/manage': () =>
        json(200, {
          ...pending,
          location: { ...pending.location, url: JOIN },
          conference: { provider: 'google_meet', status: 'ready', errorCode: null },
        }),
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Invitee')
    await user.type(screen.getByLabelText('Email'), 'invitee@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'Time reserved; meeting link pending' })
    expect(screen.queryByText(/Didn’t get the email/)).toBeNull()
    expect(screen.queryByRole('link', { name: 'Download .ics file' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Google Calendar' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Outlook' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Join Google Meet' })).toBeNull()
    // Keep the real two-second protected status poll: this exercises the page's parent
    // update, not just the isolated notice component.
    await screen.findByRole('link', { name: 'Join Google Meet' }, { timeout: 4000 })
    expect(
      screen.getByText(
        'Didn’t get the email? Check spam or junk and add the sender to your contacts.',
      ),
    ).toBeDefined()
    const download =
      screen.getByRole('link', { name: 'Download .ics file' }).getAttribute('href') ?? ''
    expect(decodeURIComponent(download)).toContain(JOIN)
    expect(api.to('GET /api/v1/bookings/manage')[0]?.headers.get('x-manage-token')).toBe(TOKEN)
    expect(api.calls.every((call) => !call.path.includes(TOKEN))).toBe(true)
  })
  it.each([false, true])(
    'books inside an embedded personal/team page without a session and sends no private data to its parent (team=%s)',
    async (team) => {
      const user = userEvent.setup(),
        postMessage = vi.fn(),
        q = '?parentOrigin=https%3A%2F%2Fparent.example&embedId=abcdefghijklmnop1234'
      vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window)
      window.history.replaceState(null, '', `/embed${team ? '/team/Alpha' : '/ada'}/intro${q}`)
      const prefix = team ? '/api/v1/public/teams/Alpha/intro' : '/api/v1/public/ada/intro'
      const api = fakeApi({
        [`GET ${prefix}`]: () =>
          json(200, {
            ...EVENT,
            allowGuests: false,
            ...(team ? { handle: 'Alpha', team: { name: 'Alpha Team', slug: 'Alpha' } } : {}),
          }),
        [`GET ${prefix}/slots`]: slotsAnswer(DST_SLOTS),
        [`POST ${prefix}/bookings`]: () => json(201, { booking: booking(), manageToken: TOKEN }),
      })
      renderApp(`/embed${team ? '/team/Alpha' : '/ada'}/intro${q}`)
      await screen.findByRole('heading', { name: 'Intro call', level: 1 })
      const resizeMessages = postMessage.mock.calls.filter(
        ([data]) => data.type === 'hourmere:resize',
      )
      expect(resizeMessages.length).toBeGreaterThan(0)
      for (const [data, targetOrigin] of resizeMessages) {
        expect(data).toEqual({ type: 'hourmere:resize', id: 'abcdefghijklmnop1234', height: 240 })
        expect(targetOrigin).toBe('https://parent.example')
      }
      await chooseSlot(user, /November 2, available/, '9:00 AM')
      await user.type(screen.getByLabelText('Your name'), 'Invitee')
      await user.type(screen.getByLabelText('Email'), 'invitee@example.com')
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      await screen.findByRole('heading', { name: 'You’re booked' })
      const cancel = screen.getByRole('link', { name: 'Cancel booking' })
      expect(cancel.getAttribute('href')).toBe(`/booking#token=${TOKEN}&action=cancel`)
      expect(cancel.getAttribute('target')).toBe('_blank')
      expect(cancel.getAttribute('rel')).toBe('noopener noreferrer')
      expect(api.to(`POST ${prefix}/bookings`)[0]?.body).toHaveProperty('source', 'embed')
      const messages = postMessage.mock.calls.filter(([data]) => data.type === 'hourmere:booked')
      expect(messages).toEqual([
        [{ type: 'hourmere:booked', id: 'abcdefghijklmnop1234' }, 'https://parent.example'],
      ])
      expect(JSON.stringify(postMessage.mock.calls).includes(TOKEN)).toBe(false)
      expect(JSON.stringify(postMessage.mock.calls).includes('invitee@example.com')).toBe(false)
      expect(
        screen
          .getByLabelText<HTMLInputElement>('Your link to change or cancel this booking')
          .value.endsWith(TOKEN),
      ).toBe(true)
      expect(
        screen.getByRole('link', { name: /Powered by Hourmere/ }).getAttribute('rel'),
      ).toContain('noreferrer')
      const consumed = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      consumed.preventDefault()
      window.dispatchEvent(consumed)
      expect(
        postMessage.mock.calls.filter(([data]) => data.type === 'hourmere:close'),
      ).toHaveLength(0)
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(postMessage.mock.calls.filter(([data]) => data.type === 'hourmere:close')).toEqual([
        [{ type: 'hourmere:close', id: 'abcdefghijklmnop1234' }, 'https://parent.example'],
      ])
      expect(
        screen.getByRole('link', { name: 'Create your own booking link' }).getAttribute('href'),
      ).toBe('https://hourmere.com')
      expect(api.to('GET /api/v1/me')).toHaveLength(0)
    },
  )
  it('normalizes embedded routes without losing the iframe boundary or correlation query', async () => {
    fakeApi(eventRoutes(EVENT, DST_SLOTS))
    renderApp(
      '/embed/ADA/INTRO?parentOrigin=https%3A%2F%2Fparent.example&embedId=abcdefghijklmnop1234',
    )
    await screen.findByRole('heading', { name: 'Intro call', level: 1 })
    expect(screen.getByTestId('location').textContent).toBe(
      '/embed/ada/intro?parentOrigin=https%3A%2F%2Fparent.example&embedId=abcdefghijklmnop1234',
    )
  })
  it('hides guest collection when the host has not opted in and books only the invitee', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...eventRoutes({ ...EVENT, allowGuests: false }, DST_SLOTS),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, { booking: booking(), manageToken: TOKEN }),
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    expect(screen.queryByRole('group', { name: /Guests/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add a guest' })).toBeNull()
    await user.type(screen.getByLabelText('Your name'), 'Invitee')
    await user.type(screen.getByLabelText('Email'), 'invitee@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    expect(api.to('POST /api/v1/public/ada/intro/bookings')[0]?.body).not.toHaveProperty('guests')
  })
  it('lets a stale form remove guests and retry with a new key after host opt-out', async () => {
    const user = userEvent.setup()
    let first = true
    const api = fakeApi({
      ...eventRoutes(EVENT, DST_SLOTS),
      'POST /api/v1/public/ada/intro/bookings': () => {
        if (first) {
          first = false
          return json(400, { error: 'guests_not_allowed' })
        }
        return json(201, { booking: booking(), manageToken: TOKEN })
      },
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Invitee')
    await user.type(screen.getByLabelText('Email'), 'invitee@example.com')
    await user.click(screen.getByRole('button', { name: 'Add a guest' }))
    await user.type(screen.getByLabelText('Guest 1 name'), 'Guest')
    await user.type(screen.getByLabelText('Guest 1 email'), 'guest@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    expect(
      await screen.findByText('The host no longer allows guests. Remove the guests to continue.'),
    ).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Remove guest 1' }))
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    const calls = api.to('POST /api/v1/public/ada/intro/bookings')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body).not.toHaveProperty('guests')
    expect(calls[0]?.headers.get('Idempotency-Key')).not.toBe(
      calls[1]?.headers.get('Idempotency-Key'),
    )
  })

  it('books through a team link without a session, preserving team case and retry identity', async () => {
    const user = userEvent.setup()
    let first = true
    const api = fakeApi({
      'GET /api/v1/public/teams/Cobaltmere/intro': () =>
        json(200, {
          ...EVENT,
          handle: 'Cobaltmere',
          team: { name: 'Cobaltmere team', slug: 'Cobaltmere' },
        }),
      'GET /api/v1/public/teams/Cobaltmere/intro/slots': slotsAnswer(['2026-11-02T14:00Z']),
      'POST /api/v1/public/teams/Cobaltmere/intro/bookings': () => {
        if (first) {
          first = false
          throw new TypeError('lost answer')
        }
        return json(201, { booking: booking(), manageToken: TOKEN })
      },
    })
    renderApp('/team/Cobaltmere/INTRO')
    expect(await screen.findByRole('heading', { level: 1, name: 'Intro call' })).toBeDefined()
    expect(screen.getByText('Cobaltmere team')).toBeDefined()
    expect(screen.getByTestId('location').textContent).toBe('/team/Cobaltmere/intro')
    await chooseSlot(user, /Monday, November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), 'grace@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByText(/Your booking is not confirmed yet/)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    expect(await screen.findByRole('heading', { name: 'You’re booked' })).toBeDefined()
    const calls = api.to('POST /api/v1/public/teams/Cobaltmere/intro/bookings')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.headers.get('idempotency-key')).toBeTruthy()
    expect(calls[1]?.headers.get('idempotency-key')).toBe(calls[0]?.headers.get('idempotency-key'))
    expect(calls[1]?.body).toEqual(calls[0]?.body)
    expect(
      api.calls.some(
        (call) =>
          call.path.startsWith('/api/v1/me') || call.path.startsWith('/api/v1/public/Cobaltmere/'),
      ),
    ).toBe(false)
    expect(
      screen.getByLabelText<HTMLInputElement>('Your link to change or cancel this booking').value,
    ).toContain('#token=')
  })

  it('shows the event and offers times in the visitor’s zone across a DST change', async () => {
    const user = userEvent.setup()
    const api = fakeApi(eventRoutes(EVENT, DST_SLOTS))
    renderApp('/ada/intro')

    expect(await screen.findByRole('heading', { level: 1, name: 'Intro call' })).toBeDefined()
    expect(screen.getByText('Ada Lovelace')).toBeDefined()
    expect(screen.getByText('30 min')).toBeDefined()
    expect(screen.getByText('Phone call')).toBeDefined()
    expect(screen.getByText('A first conversation.')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeDefined()
    // The zone is shown with its offset.
    expect(plain(screen.getByRole('button', { name: /Time zone/ }).textContent)).toContain(
      'America/New York',
    )

    expect(await day('Sunday, November 1, available')).toBeDefined()
    expect(await day('Monday, November 2, available')).toBeDefined()
    // 03:30Z on the 3rd is still the 2nd in New York.
    expect(await day('Tuesday, November 3, no times available')).toBeDefined()

    await user.click(await day(/November 1, available/))
    // The wall time that happens twice is told apart by its zone abbreviation.
    expect(slotButtons()).toEqual(['1:30 AM EDT', '1:30 AM EST'])
    await user.click(await day(/November 2, available/))
    expect(slotButtons()).toEqual(['5:30 AM', '9:00 AM', '10:30 PM'])
    expect(screen.getByText(/3 times available on Monday, November 2/)).toBeDefined()

    // One request covers the month in any zone: from now to the UTC month's end plus 14 hours
    // and the meeting's length.
    const requests = api.to('GET /api/v1/public/ada/intro/slots')
    expect(requests).toHaveLength(1)
    const query = new URL(requests[0]?.path ?? '', 'http://x').searchParams
    expect(query.get('start')).toBe('2026-11-01T04:30:00.000Z')
    expect(query.get('end')).toBe('2026-12-01T14:30:00.000Z')
  })

  it('regroups the same slots for a zone far from UTC without asking again', async () => {
    const user = userEvent.setup()
    env.zone = 'Pacific/Kiritimati' // UTC+14: already 18:30 on November 1
    const api = fakeApi(eventRoutes(EVENT, DST_SLOTS))
    renderApp('/ada/intro')

    // 10:30Z and 14:00Z on the 2nd are 00:30 and 04:00 on the 3rd here, 03:30Z on the 3rd 17:30.
    await user.click(await day('Tuesday, November 3, available'))
    expect(slotButtons()).toEqual(['12:30 AM', '4:00 AM', '5:30 PM'])
    expect(plain(screen.getByRole('button', { name: /Time zone/ }).textContent)).toContain(
      'GMT+14:00',
    )

    // Switch to UTC through the searchable list.
    await user.click(screen.getByRole('button', { name: /Time zone/ }))
    const search = screen.getByRole('combobox', { name: 'Search time zones' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    await user.type(search, 'utc')
    await user.keyboard('{Enter}')
    expect(plain(screen.getByRole('button', { name: /Time zone/ }).textContent)).toContain('UTC')
    // Now the 2nd holds them, and the 3rd only the 03:30Z slot.
    await user.click(await day('Monday, November 2, available'))
    expect(slotButtons()).toEqual(['10:30 AM', '2:00 PM'])
    expect(api.to('GET /api/v1/public/ada/intro/slots')).toHaveLength(1)
  })

  it('finds zones by city or offset and closes with Escape', async () => {
    const user = userEvent.setup()
    fakeApi(eventRoutes(EVENT, DST_SLOTS))
    renderApp('/ada/intro')
    const toggle = await screen.findByRole('button', { name: /Time zone/ })
    await user.click(toggle)
    const search = screen.getByRole('combobox', { name: 'Search time zones' })
    await user.type(search, 'kolkata')
    const options = within(screen.getByRole('listbox', { name: 'Time zones' })).getAllByRole(
      'option',
    )
    expect(options.map((o) => o.textContent)).toEqual(['Asia/KolkataGMT+05:30'])
    await user.clear(search)
    await user.type(search, 'gmt+05:45')
    expect(
      within(screen.getByRole('listbox', { name: 'Time zones' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Asia/KathmanduGMT+05:45'])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('combobox', { name: 'Search time zones' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(toggle))
  })

  it('moves through the calendar with the keyboard', async () => {
    const user = userEvent.setup()
    const api = fakeApi(eventRoutes(EVENT, DST_SLOTS))
    renderApp('/ada/intro')
    const first = await day(/November 1, available/)
    // One tab stop: today.
    expect(first.tabIndex).toBe(0)
    first.focus()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Monday, November 2/)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Monday, November 9/)
    await user.keyboard('{End}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Saturday, November 14/)
    await user.keyboard('{Home}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Sunday, November 8/)
    // Before the first day of the current month nothing happens.
    await user.keyboard('{PageUp}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Sunday, November 8/)
    await user.keyboard('{PageDown}')
    expect(await screen.findByRole('heading', { name: 'December 2026' })).toBeDefined()
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Tuesday, December 8/),
    )
    expect(api.to('GET /api/v1/public/ada/intro/slots')).toHaveLength(2)
    await user.keyboard('{PageUp}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowRight}')
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Monday, November 2/)
    await user.keyboard('{Enter}')
    expect(slotButtons()).toEqual(['5:30 AM', '9:00 AM', '10:30 PM'])
  })

  it('keeps a long meeting that starts on the month’s last day in a zone behind UTC', async () => {
    const user = userEvent.setup()
    env.zone = 'Pacific/Pago_Pago' // UTC-11
    env.now = Date.parse('2026-11-20T00:00:00Z')
    // 09:00–17:00 UTC on December 1 starts at 22:00 on November 30 in Pago Pago.
    fakeApi(eventRoutes({ ...EVENT, durationMinutes: 480 }, ['2026-12-01T09:00:00Z']))
    renderApp('/ada/intro')
    await user.click(await day('Monday, November 30, available'))
    expect(slotButtons()).toEqual(['10:00 PM'])
    // December does not show it again on its UTC day.
    await user.click(screen.getByRole('button', { name: 'Next month' }))
    expect(await screen.findByRole('heading', { name: 'December 2026' })).toBeDefined()
    expect(await day('Tuesday, December 1, no times available')).toBeDefined()
  })

  it('keeps a meeting that starts on the 1st far ahead of UTC, still the month before there', async () => {
    const user = userEvent.setup()
    env.zone = 'Pacific/Kiritimati' // UTC+14
    env.now = Date.parse('2026-11-25T00:00:00Z')
    fakeApi(
      eventRoutes({ ...EVENT, durationMinutes: 480 }, [
        '2026-11-30T09:00:00Z', // 23:00 on November 30 there
        '2026-11-30T10:00:00Z', // 00:00 on December 1 there
      ]),
    )
    renderApp('/ada/intro')
    await user.click(await day('Monday, November 30, available'))
    expect(slotButtons()).toEqual(['11:00 PM'])
    await user.click(screen.getByRole('button', { name: 'Next month' }))
    await user.click(await day('Tuesday, December 1, available'))
    expect(slotButtons()).toEqual(['12:00 AM'])
  })

  it.each([
    // fa-IR defaults to the Persian calendar (2 November 2026 is 11 Aban 1405), th-TH to the
    // Buddhist era (2569); the grid and every label must show the same Gregorian days.
    ['fa-IR', 'نوامبر ۲۰۲۶', '۲', 'دوشنبه ۲ نوامبر ۲۰۲۶', /آبان|۱۴۰۵/],
    ['th-TH', 'พฤศจิกายน 2026', '2', 'วันจันทร์ที่ 2 พฤศจิกายน 2026', /2569/],
  ])(
    'labels days in the Gregorian calendar for %s, from the grid to the confirmation',
    async (locale, month, digit, date, otherCalendar) => {
      const user = userEvent.setup()
      env.locale = locale
      fakeApi({
        ...eventRoutes(EVENT, DST_SLOTS),
        'POST /api/v1/public/ada/intro/bookings': () =>
          json(201, { booking: booking(), manageToken: TOKEN }),
      })
      renderApp('/ada/intro')
      expect(await screen.findByRole('heading', { name: month })).toBeDefined()
      const nov2 = await waitFor(() => {
        const button = document.querySelector<HTMLButtonElement>('[data-day="2026-11-02"]')
        expect(button?.getAttribute('aria-label')).toMatch(/available$/)
        return button as HTMLButtonElement
      })
      expect(nov2.textContent).toBe(digit)
      expect(nov2.getAttribute('aria-label')).toContain(month.split(' ')[0])
      await user.click(nov2)
      expect(document.querySelector('.slots-day')?.textContent).toContain(month.split(' ')[0])
      const times = within(screen.getByRole('list', { name: /^Times on/ })).getAllByRole('button')
      await user.click(times[1] as HTMLElement) // 14:00 UTC
      expect(document.body.textContent).toContain(date)
      await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
      await user.type(screen.getByLabelText('Email'), 'grace@example.com')
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      expect(await screen.findByRole('heading', { name: 'You’re booked' })).toBeDefined()
      expect(document.body.textContent).toContain(date)
      expect(document.body.textContent).not.toMatch(otherCalendar)
    },
  )

  it('moves on to the next month when this one has nothing left, and says so when none has', async () => {
    fakeApi(eventRoutes(EVENT, ['2026-12-15T15:00:00Z']))
    renderApp('/ada/intro')
    expect(await screen.findByRole('heading', { name: 'December 2026' })).toBeDefined()
    expect(await day('Tuesday, December 15, available')).toBeDefined()
  })

  it('says when no times are available', async () => {
    const user = userEvent.setup()
    fakeApi(eventRoutes(EVENT, []))
    renderApp('/ada/intro')
    // November and the two months after it are empty: the page stops in January.
    expect(await screen.findByRole('heading', { name: 'January 2027' })).toBeDefined()
    expect(await screen.findByText('No available times this month.')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Show next month' }))
    expect(await screen.findByRole('heading', { name: 'February 2027' })).toBeDefined()
  })

  it('checks the form as the API would before sending it', async () => {
    const user = userEvent.setup()
    const api = fakeApi(eventRoutes({ ...EVENT, questions: ALL_QUESTIONS }, DST_SLOTS))
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')

    const details = await screen.findByRole('heading', { name: 'Your details' })
    await waitFor(() => expect(document.activeElement).toBe(details))
    // The chosen time, in the visitor's zone.
    expect(
      plain(screen.getByText(/^Monday, November 2, 2026$/).parentElement?.textContent),
    ).toMatch(/9:00 – 9:30 AM.*America\/New York \(GMT-05:00\)/)
    // All six kinds of question.
    expect(screen.getByLabelText('Topic').tagName).toBe('INPUT')
    expect(screen.getByLabelText(/Anything else\?/).tagName).toBe('TEXTAREA')
    expect(screen.getByLabelText(/Phone/)).toHaveProperty('type', 'tel')
    expect(screen.getByLabelText('Team size').tagName).toBe('SELECT')
    expect(screen.getByRole('group', { name: /Tools/ })).toBeDefined()
    expect(screen.getByLabelText('I agree to the terms')).toHaveProperty('type', 'checkbox')

    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    expect(api.to('POST /api/v1/public/ada/intro/bookings')).toHaveLength(0)
    const name = screen.getByLabelText('Your name')
    expect(document.activeElement?.classList.contains('error-summary')).toBe(true)
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Enter your name.')).toBeDefined()
    expect(screen.getByText('Enter an email address.')).toBeDefined()
    expect(screen.getByText('This answer is required.')).toBeDefined()
    expect(screen.getByText('Choose an option.')).toBeDefined()
    expect(screen.getByText('Check this box to continue.')).toBeDefined()

    // Errors follow corrections.
    await user.type(name, 'Grace Hopper')
    expect(screen.queryByText('Enter your name.')).toBeNull()
    await user.type(screen.getByLabelText('Email'), 'grace@example')
    expect(
      screen.getByText(/Enter a valid email address/, { selector: '.field-error' }),
    ).toBeDefined()
    await user.type(screen.getByLabelText(/Phone/), 'call me')
    expect(screen.getByText(/Enter a phone number/, { selector: '.field-error' })).toBeDefined()
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'x'.repeat(501) } })
    expect(
      screen.getByText('Use at most 500 characters.', { selector: '.field-error' }),
    ).toBeDefined()

    // Up to ten guests.
    for (let i = 0; i < 10; i++)
      await user.click(screen.getByRole('button', { name: 'Add a guest' }))
    expect(screen.queryByRole('button', { name: 'Add a guest' })).toBeNull()
    expect(screen.getByText('You can add up to 10 guests.')).toBeDefined()
    expect(screen.getAllByRole('button', { name: /^Remove guest/ })).toHaveLength(10)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    expect(api.to('POST /api/v1/public/ada/intro/bookings')).toHaveLength(0)
    expect(document.activeElement?.classList.contains('error-summary')).toBe(true)
  })

  it('books with one Idempotency-Key per attempt and shows the confirmation', async () => {
    const user = userEvent.setup()
    const questions = ALL_QUESTIONS.slice(0, 1)
    let attempts = 0
    const made = booking({
      attendees: [
        {
          name: 'Grace Hopper',
          email: 'grace@example.com',
          timeZone: 'America/New_York',
          locale: 'en-US',
          isBooker: true,
        },
        {
          name: 'Alan',
          email: 'alan@example.com',
          timeZone: 'America/New_York',
          locale: null,
          isBooker: false,
        },
      ],
    })
    const api = fakeApi({
      ...eventRoutes({ ...EVENT, questions }, DST_SLOTS),
      'POST /api/v1/public/ada/intro/bookings': () => {
        attempts += 1
        // The first answer is lost on the way back; the retry is answered as a replay.
        if (attempts === 1) throw new TypeError('Failed to fetch')
        return json(attempts === 2 ? 200 : 201, {
          booking: made,
          manageToken: attempts === 2 ? null : TOKEN,
        })
      },
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), '  Grace Hopper ')
    await user.type(screen.getByLabelText('Email'), 'grace@example.com')
    await user.type(screen.getByLabelText('Topic'), ' Compilers ')
    await user.click(screen.getByRole('button', { name: 'Add a guest' }))
    await user.type(screen.getByLabelText('Guest 1 name'), 'Alan')
    await user.type(screen.getByLabelText('Guest 1 email'), 'alan@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))

    expect(await screen.findByText(/Your booking is not confirmed yet/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    expect(await screen.findByRole('heading', { name: 'You’re booked' })).toBeDefined()

    const posts = api.to('POST /api/v1/public/ada/intro/bookings')
    expect(posts).toHaveLength(2)
    expect(posts[0]?.body).toEqual({
      start: '2026-11-02T14:00:00.000Z',
      invitee: {
        name: 'Grace Hopper',
        email: 'grace@example.com',
        timeZone: 'America/New_York',
        locale: 'en-US',
      },
      guests: [{ name: 'Alan', email: 'alan@example.com' }],
      responses: { topic: 'Compilers' },
    })
    const key = posts[0]?.headers.get('idempotency-key')
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // The retry of the same request reuses the key.
    expect(posts[1]?.headers.get('idempotency-key')).toBe(key)
    expect(posts[1]?.body).toEqual(posts[0]?.body)
    // A replay has no manage token to show.
    const replayNote = screen.getByText(/already made by an earlier attempt/)
    expect(screen.queryByLabelText(/Your link to change or cancel/)).toBeNull()
    const calendarNote = screen.getByText(
      'Accepting or declining the calendar invitation does not cancel the booking. To cancel, use the booking link in your Hourmere confirmation email.',
    )
    expect(replayNote.parentElement).toBe(calendarNote.parentElement)
    expect(document.querySelectorAll('.confirmation .alert-info')).toHaveLength(1)
    expectStackGap(calendarNote.parentElement?.parentElement as HTMLElement)
    expect(screen.queryByRole('link', { name: 'Cancel booking' })).toBeNull()
    await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(screen.getByText('此前的尝试已创建此预约，因此无法再次显示预约链接。')).toBeDefined()
    expect(
      screen.getByText(
        '在日历中接受或拒绝邀请不会取消预约。如需取消，请使用 Hourmere 确认邮件中的预约链接。',
      ),
    ).toBeDefined()
  })

  it.each([
    { languages: ['fr-FR', 'zh-Hans-CN'], language: 'zh-CN', locale: 'zh-CN' },
    { languages: ['fr-FR', 'de-DE'], language: 'en', locale: 'en' },
    { languages: ['zh-Hans-CN', 'en-US'], language: 'zh-CN', locale: 'zh-Hans-CN' },
  ])(
    'stores the visible interface language for browser preferences $languages',
    async ({ languages, language, locale }) => {
      const user = userEvent.setup()
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages)
      env.locale = languages[0] ?? 'en'
      const chinese = language === 'zh-CN'
      const api = fakeApi({
        ...eventRoutes({ ...EVENT, allowGuests: false }, ['2026-11-02T14:00:00Z']),
        'POST /api/v1/public/ada/intro/bookings': () =>
          json(201, { booking: booking(), manageToken: TOKEN }),
      })
      renderApp('/ada/intro')
      await screen.findByRole('heading', { name: 'Intro call', level: 1 })
      expect(
        screen.getByRole<HTMLSelectElement>('combobox', {
          name: chinese ? '界面语言' : 'Interface language',
        }).value,
      ).toBe(language)
      const selectedDay = await waitFor(() => {
        const button = document.querySelector<HTMLButtonElement>('[data-day="2026-11-02"]')
        expect(button?.disabled).toBe(false)
        return button as HTMLButtonElement
      })
      await user.click(selectedDay)
      const times = screen.getByRole('list', { name: chinese ? /的时间$/ : /^Times on/ })
      await user.click(within(times).getAllByRole('button')[0] as HTMLElement)
      await user.type(screen.getByLabelText(chinese ? '你的姓名' : 'Your name'), 'Invitee')
      await user.type(screen.getByLabelText(chinese ? '邮箱' : 'Email'), 'invitee@example.invalid')
      await user.click(
        screen.getByRole('button', { name: chinese ? '确认预约' : 'Confirm booking' }),
      )
      await screen.findByRole('heading', { name: chinese ? '预约成功' : 'You’re booked' })
      expect(api.to('POST /api/v1/public/ada/intro/bookings')[0]?.body).toHaveProperty(
        'invitee.locale',
        locale,
      )
    },
  )

  it('uses a new key after an idempotency conflict even if the form is unchanged', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const api = fakeApi({
      ...eventRoutes(EVENT, DST_SLOTS),
      'POST /api/v1/public/ada/intro/bookings': () =>
        ++attempts === 1
          ? json(409, { error: 'idempotency_key_reused' })
          : json(201, { booking: booking(), manageToken: TOKEN }),
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), 'grace@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByText('Something went wrong with this attempt. Please try again.')
    expect(api.to('POST /api/v1/public/ada/intro/bookings')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    const [first, second] = api.to('POST /api/v1/public/ada/intro/bookings')
    expect(second?.body).toEqual(first?.body)
    expect(first?.headers.get('idempotency-key')).toBeTruthy()
    expect(second?.headers.get('idempotency-key')).toBeTruthy()
    expect(second?.headers.get('idempotency-key')).not.toBe(first?.headers.get('idempotency-key'))
  })

  it('sorts unsorted response times by instant, including a repeated DST wall time', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...eventRoutes(EVENT, []),
      'GET /api/v1/public/ada/intro/slots': () =>
        json(200, { data: [slot('2026-11-01T06:30:00Z'), slot('2026-11-01T05:30:00Z')] }),
    })
    renderApp('/ada/intro')
    await user.click(await day(/November 1, available/))
    expect(slotButtons()).toEqual(['1:30 AM EDT', '1:30 AM EST'])
  })

  it('starts a new attempt when the request changes, and shows the manage link once', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const api = fakeApi({
      ...eventRoutes(EVENT, DST_SLOTS),
      'POST /api/v1/public/ada/intro/bookings': () => {
        attempts += 1
        if (attempts === 1) return json(503, { error: 'internal_error' })
        return json(201, { booking: booking(), manageToken: TOKEN })
      },
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), 'grace@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    expect(await screen.findByText(/Something went wrong on our side/)).toBeDefined()
    await user.clear(screen.getByLabelText('Email'))
    await user.type(screen.getByLabelText('Email'), 'grace.hopper@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))

    const heading = await screen.findByRole('heading', { name: 'You’re booked' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    const [first, second] = api.to('POST /api/v1/public/ada/intro/bookings')
    expect(second?.headers.get('idempotency-key')).not.toBe(first?.headers.get('idempotency-key'))

    // The details, in the visitor's zone.
    expect(
      plain(screen.getByText(/^Monday, November 2, 2026$/).parentElement?.textContent),
    ).toMatch(/9:00 – 9:30 AM \(America\/New York, GMT-05:00\)/)
    expect(screen.getByRole('link', { name: '+49 30 1234567' }).getAttribute('href')).toBe(
      'tel:+49301234567',
    )
    const link = screen.getByLabelText<HTMLInputElement>(/Your link to change or cancel/)
    expect(link.value).toBe(`${window.location.origin}/booking#token=${TOKEN}`)
    // Calendar links carry the meeting, never the manage token.
    const ics = screen.getByRole('link', { name: 'Download .ics file' }).getAttribute('href') ?? ''
    expect(ics).toMatch(/^data:text\/calendar/)
    expect(decodeURIComponent(ics)).toContain('UID:01900000-0000-7000-8000-0000000000b1@hourmere')
    for (const name of ['Download .ics file', 'Google Calendar', 'Outlook']) {
      const href = screen.getByRole('link', { name }).getAttribute('href') ?? ''
      expect(decodeURIComponent(href)).not.toContain(TOKEN)
    }
    expect(screen.getByRole('link', { name: 'Google Calendar' }).getAttribute('rel')).toContain(
      'noreferrer',
    )
  })

  it('omits fully empty guests and maps server errors back to the submitted guest row', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...eventRoutes(EVENT, DST_SLOTS),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(400, { error: 'invalid_request', message: 'guests.0.email: Invalid email' }),
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), 'grace@example.com')
    await user.click(screen.getByRole('button', { name: 'Add a guest' }))
    await user.click(screen.getByRole('button', { name: 'Add a guest' }))
    const names = [screen.getByLabelText('Guest 1 name'), screen.getByLabelText('Guest 2 name')]
    const emails = [
      screen.getByLabelText('Email'),
      screen.getByLabelText('Guest 1 email'),
      screen.getByLabelText('Guest 2 email'),
    ]
    await user.type(names[1] as HTMLElement, 'Guest')
    await user.type(emails[2] as HTMLElement, 'guest@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    const summary = await screen.findByRole('alert', { name: 'Please check the form' })
    expect(api.to('POST /api/v1/public/ada/intro/bookings')[0]?.body).toMatchObject({
      guests: [{ name: 'Guest', email: 'guest@example.com' }],
    })
    expect(emails[1]?.getAttribute('aria-invalid')).toBeNull()
    expect(emails[2]?.getAttribute('aria-invalid')).toBe('true')
    await user.click(within(summary).getByRole('link'))
    expect(document.activeElement).toBe(emails[2])
  })

  it('puts the server’s objections on the fields they are about', async () => {
    const user = userEvent.setup()
    const answers = [
      json(400, { error: 'invalid_request', message: 'invitee.email: Invalid email address' }),
      json(400, { error: 'invalid_responses', message: 'Question "topic" is required' }),
      json(429, { error: 'rate_limited' }),
    ]
    fakeApi({
      ...eventRoutes({ ...EVENT, questions: ALL_QUESTIONS.slice(0, 1) }, DST_SLOTS),
      'POST /api/v1/public/ada/intro/bookings': () => {
        const answer = answers.shift() as Response
        if (answer.status === 429) answer.headers.set('Retry-After', '30')
        return answer
      },
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), "o'grace@example.com")
    await user.type(screen.getByLabelText('Topic'), 'Compilers')
    const confirm = () => user.click(screen.getByRole('button', { name: 'Confirm booking' }))

    await confirm()
    const email = screen.getByLabelText('Email')
    await waitFor(() => expect(email.getAttribute('aria-invalid')).toBe('true'))
    await waitFor(() =>
      expect(document.activeElement?.classList.contains('error-summary')).toBe(true),
    )
    expect(
      screen.getByText(/Enter a valid email address/, { selector: '.field-error' }),
    ).toBeDefined()

    await confirm()
    expect(await screen.findByText('Check this answer.')).toBeDefined()
    await waitFor(() =>
      expect(document.activeElement?.classList.contains('error-summary')).toBe(true),
    )

    await confirm()
    expect(await screen.findByText(/Try again in 30 seconds/)).toBeDefined()
  })

  it.each(['slot_taken', 'booking_changed'])(
    'refreshes availability and keeps entered details after %s',
    async (error) => {
      const user = userEvent.setup()
      let taken = false
      const api = fakeApi({
        ...eventRoutes(EVENT, DST_SLOTS),
        'GET /api/v1/public/ada/intro/slots': (call) =>
          slotsAnswer(taken ? DST_SLOTS.filter((s) => s !== '2026-11-02T14:00:00Z') : DST_SLOTS)(
            call,
          ),
        'POST /api/v1/public/ada/intro/bookings': ({ body }) => {
          if ((body as { start: string }).start === '2026-11-02T14:00:00.000Z') {
            taken = true
            return json(409, { error })
          }
          return json(201, {
            booking: booking({ start: '2026-11-02T10:30:00.000Z' }),
            manageToken: TOKEN,
          })
        },
      })
      renderApp('/ada/intro')
      await chooseSlot(user, /November 2, available/, '9:00 AM')
      await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
      await user.type(screen.getByLabelText('Email'), 'grace@example.com')
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))

      expect(
        await screen.findByText(
          error === 'slot_taken'
            ? /Someone else just booked that time/
            : /That time is no longer available/,
        ),
      ).toBeDefined()
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Pick a time' })),
      )
      await waitFor(() => expect(api.to('GET /api/v1/public/ada/intro/slots')).toHaveLength(2))
      await user.click(await day(/November 2, available/))
      expect(slotButtons()).toEqual(['5:30 AM', '10:30 PM'])
      await user.click(screen.getByRole('button', { name: '5:30 AM' }))
      // What they typed is still there.
      expect(screen.getByLabelText<HTMLInputElement>('Your name').value).toBe('Grace Hopper')
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      expect(await screen.findByRole('heading', { name: 'You’re booked' })).toBeDefined()
      const posts = api.to('POST /api/v1/public/ada/intro/bookings')
      expect(posts[1]?.headers.get('idempotency-key')).not.toBe(
        posts[0]?.headers.get('idempotency-key'),
      )
    },
  )

  it('shows a not-found page for an unknown event, and asks nothing for impossible addresses', async () => {
    fakeApi({
      'GET /api/v1/public/ada/nope': () =>
        json(404, { error: 'event_type_not_found', message: 'No such event type' }),
    })
    renderApp('/ada/nope')
    expect(
      await screen.findByRole('heading', { name: 'This booking page doesn’t exist' }),
    ).toBeDefined()
    // Not a handle: no request at all (an unexpected one would fail the test).
    renderApp('/ada_l/intro')
    expect(
      await screen.findAllByRole('heading', { name: 'This booking page doesn’t exist' }),
    ).toHaveLength(2)
  })

  it('offers to try again when the event cannot be loaded', async () => {
    const user = userEvent.setup()
    let fail = true
    fakeApi({
      ...eventRoutes(EVENT, DST_SLOTS),
      'GET /api/v1/public/ada/intro': () => {
        if (fail) {
          fail = false
          throw new TypeError('Failed to fetch')
        }
        return json(200, EVENT)
      },
    })
    renderApp('/ada/intro')
    expect(await screen.findByText(/Can't reach Hourmere/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Intro call' })).toBeDefined()
  })

  it('keeps slot lists whole when the server asks for a shorter range', async () => {
    const user = userEvent.setup()
    // A one-minute step: the server refuses a whole month (range_too_long).
    const api = fakeApi({
      ...eventRoutes(EVENT),
      'GET /api/v1/public/ada/intro/slots': (call) => {
        const query = new URL(call.path, 'http://x').searchParams
        const days =
          (Date.parse(query.get('end') ?? '') - Date.parse(query.get('start') ?? '')) / 86_400_000
        if (days > 13) return json(400, { error: 'range_too_long' })
        return slotsAnswer(['2026-11-16T14:50:00Z'], 30)(call)
      },
    })
    renderApp('/ada/intro')
    await user.click(await day('Monday, November 16, available'))
    expect(slotButtons()).toEqual(['9:50 AM'])
    expect(api.to('GET /api/v1/public/ada/intro/slots').length).toBeGreaterThan(2)
  })
})

describe('the host page', () => {
  it('lists the host’s event types and links to their booking pages', async () => {
    const user = userEvent.setup()
    fakeApi({
      'GET /api/v1/public/ada': () =>
        json(200, {
          handle: 'ada',
          host: { name: 'Ada Lovelace', timeZone: 'Europe/Berlin' },
          eventTypes: [
            {
              slug: 'intro',
              title: 'Intro call',
              description: null,
              durationMinutes: 30,
              location: { kind: 'zoom' },
            },
            {
              slug: 'deep-dive',
              title: 'Deep dive',
              description: 'Bring code.',
              durationMinutes: 90,
              location: null,
            },
          ],
        }),
      ...eventRoutes(EVENT, DST_SLOTS),
    })
    renderApp('/Ada')
    expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeDefined()
    expect(screen.getByTestId('location').textContent).toBe('/ada')
    const deepDive = screen.getByRole('link', { name: /Deep dive/ })
    expect(deepDive.getAttribute('href')).toBe('/ada/deep-dive')
    expect(deepDive.textContent).toContain('1 h 30 min')
    expect(screen.getByRole('link', { name: /Intro call/ }).textContent).toContain('30 min · Zoom')
    await user.click(screen.getByRole('link', { name: /Intro call/ }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Intro call' })).toBeDefined()
  })

  it('says when a host has nothing to book, and when there is no such host', async () => {
    fakeApi({
      'GET /api/v1/public/empty': () =>
        json(200, { handle: 'empty', host: { name: 'Empty', timeZone: 'UTC' }, eventTypes: [] }),
      'GET /api/v1/public/nobody': () =>
        json(404, { error: 'host_not_found', message: 'No such booking page' }),
    })
    renderApp('/empty')
    expect(await screen.findByText('Empty has no events you can book right now.')).toBeDefined()
    renderApp('/nobody')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeDefined()
  })
})

it.each(['', ' \t '])(
  'uses a generic host name for a nameless assigned person (%j)',
  async (name) => {
    const user = userEvent.setup()
    fakeApi({
      ...eventRoutes(
        { ...EVENT, schedulingType: 'round_robin', host: { name: 'Team pool', timeZone: 'UTC' } },
        DST_SLOTS,
      ),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, {
          booking: booking({ assignedHost: { name, timeZone: 'UTC' } }),
          manageToken: TOKEN,
        }),
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Synthetic')
    await user.type(screen.getByLabelText('Email'), 'synthetic@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    expect(screen.getByText('Host (UTC)')).toBeDefined()
    expect(screen.getByText('Your Intro call with Host is confirmed.')).toBeDefined()
    expect(screen.queryByText('Team pool')).toBeNull()
  },
)

it.each([false, true])(
  'uses the actual safe assigned host in confirmation, including unavailable fallback (%s)',
  async (deleted) => {
    const user = userEvent.setup()
    fakeApi({
      ...eventRoutes(
        { ...EVENT, schedulingType: 'round_robin', host: { name: 'Team pool', timeZone: 'UTC' } },
        DST_SLOTS,
      ),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, {
          booking: booking({
            assignedHost: deleted
              ? null
              : { name: 'Actual selected person', timeZone: 'Asia/Shanghai' },
          }),
          manageToken: TOKEN,
        }),
    })
    renderApp('/ada/intro')
    await chooseSlot(user, /November 2, available/, '9:00 AM')
    await user.type(screen.getByLabelText('Your name'), 'Synthetic')
    await user.type(screen.getByLabelText('Email'), 'synthetic@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    expect(
      screen.getByText(
        deleted ? 'Host no longer available' : 'Actual selected person (Asia/Shanghai)',
      ),
    ).toBeDefined()
    expect(screen.queryByText('Team pool')).toBeNull()
  },
)
