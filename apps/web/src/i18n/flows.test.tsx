import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App.tsx'
import {
  fakeApi,
  instance,
  json,
  profile,
  renderApp,
  signedIn,
  signedOut,
} from '../test/fake-api.tsx'
import { eventType, SCHEDULE_ID, schedule } from '../test/fixtures.ts'
import {
  booking,
  EVENT,
  eventRoutes,
  managed,
  NEW_TOKEN,
  slotsAnswer,
  TOKEN,
} from '../test/public-fixtures.ts'

vi.mock('../public/env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public/env.ts')>()),
  detectTimeZone: () => 'America/New_York',
  preferredLocale: () => 'en-US',
  now: () => Date.parse('2026-11-01T04:30:00Z'),
}))
beforeEach(() => window.history.replaceState(null, '', '/'))
const setLanguage = async (user: ReturnType<typeof userEvent.setup>, language: 'en' | 'zh-CN') => {
  await user.selectOptions(
    screen.getByRole('combobox', { name: /^(Interface language|界面语言)$/ }),
    language,
  )
}
async function pick(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /November 2, available/ }))
  await user.click(screen.getByRole('button', { name: '9:00 AM' }))
}

describe('changing interface language through booking and account flows', () => {
  it.each(['personal', 'team', 'embed'] as const)(
    'keeps the same %s booking attempt after a lost response, with all draft and answer state intact',
    async (kind) => {
      const user = userEvent.setup(),
        postMessage = vi.fn()
      const team = kind === 'team',
        embed = kind === 'embed'
      const prefix = team ? '/api/v1/public/teams/Alpha/intro' : '/api/v1/public/ada/intro'
      const path = embed
        ? '/embed/ada/intro?parentOrigin=https%3A%2F%2Fparent.example&embedId=abcdefghijklmnop1234&language=en'
        : team
          ? '/team/Alpha/intro'
          : '/ada/intro'
      if (embed) {
        vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window)
        window.history.replaceState(null, '', path)
      }
      let attempts = 0
      const event = {
        ...EVENT,
        allowGuests: false,
        title: 'Settings',
        questions: [
          { id: 'question', type: 'short_text' as const, label: 'Email', required: true },
        ],
        ...(team ? { handle: 'Alpha', team: { name: 'Settings', slug: 'Alpha' } } : {}),
      }
      const api = fakeApi({
        [`GET ${prefix}`]: () => json(200, event),
        [`GET ${prefix}/slots`]: slotsAnswer(['2026-11-02T14:00:00Z']),
        [`POST ${prefix}/bookings`]: () => {
          attempts++
          if (attempts === 1) throw new TypeError('lost response')
          return json(200, { booking: booking(), manageToken: null })
        },
      })
      renderApp(path)
      await pick(user)
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      expect(screen.getByText('Enter your name.')).toBeDefined()
      const name = screen.getByLabelText<HTMLInputElement>('Your name')
      if (embed) expect(screen.queryByRole('combobox', { name: 'Interface language' })).toBeNull()
      else await setLanguage(user, 'zh-CN')
      const attribution = screen.getByRole('contentinfo').querySelector('a')
      expect(attribution?.textContent).toBe(embed ? 'Powered by Hourmere' : '由 Hourmere 提供支持')
      expect(attribution?.getAttribute('href')).toBe('https://hourmere.com')
      expect(attribution?.querySelector('.logo-word')?.textContent).toBe('Hourmere')
      expect(screen.getByText(embed ? 'Enter your name.' : '请输入你的姓名。')).toBeDefined()
      expect(screen.getByLabelText(embed ? 'Your name' : '你的姓名')).toBe(name)
      expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeDefined()
      await user.type(name, 'Synthetic invitee')
      await user.type(
        screen.getByLabelText(embed ? 'Email' : '邮箱', { selector: 'input[type="email"]' }),
        'invitee@example.invalid',
      )
      // A host-defined question that matches a built-in translation key stays unchanged.
      await user.type(
        screen.getByLabelText('Email', { selector: 'input[type="text"]' }),
        'Settings',
      )
      await user.click(screen.getByRole('button', { name: embed ? 'Confirm booking' : '确认预约' }))
      expect(await screen.findByRole('alert')).toHaveProperty(
        'textContent',
        expect.stringContaining(embed ? 'Your booking is not confirmed yet.' : '你的预约尚未确认'),
      )
      if (!embed) await setLanguage(user, 'en')
      expect(screen.getByRole('alert').textContent).toContain('Your booking is not confirmed yet.')
      expect(name.value).toBe('Synthetic invitee')
      expect(screen.getByDisplayValue<HTMLInputElement>('Settings').value).toBe('Settings')
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      await screen.findByRole('heading', { name: 'You’re booked' })
      expect(
        screen.getByText(
          'Didn’t get the email? Check spam or junk and add the sender to your contacts.',
        ),
      ).toBeDefined()
      const calls = api.to(`POST ${prefix}/bookings`)
      expect(calls).toHaveLength(2)
      expect(
        calls[0]?.headers.get('idempotency-key') === calls[1]?.headers.get('idempotency-key'),
      ).toBe(true)
      expect(calls[0]?.body).toEqual(calls[1]?.body)
      expect(calls[0]?.body).toHaveProperty('invitee.locale', embed ? 'en' : 'zh-CN')
      expect(calls[0]?.body).toHaveProperty('responses.question', 'Settings')
      if (embed) expect(calls[0]?.body).toHaveProperty('source', 'embed')
      if (!embed) {
        await setLanguage(user, 'zh-CN')
        expect(screen.getByRole('heading', { name: '预约成功' })).toBeDefined()
        expect(
          screen.getByText('没收到邮件？请检查垃圾邮件文件夹，并将发件人加入通讯录。'),
        ).toBeDefined()
      }
      expect(api.to('GET /api/v1/me')).toHaveLength(0)
      expect(api.to('GET /api/v1/profile')).toHaveLength(0)
      expect(api.calls.every((call) => !call.path.includes(TOKEN))).toBe(true)
      if (embed) {
        expect(postMessage.mock.calls.filter(([data]) => data.type === 'hourmere:booked')).toEqual([
          [{ type: 'hourmere:booked', id: 'abcdefghijklmnop1234' }, 'https://parent.example'],
        ])
        expect(JSON.stringify(postMessage.mock.calls).includes('invitee@example.invalid')).toBe(
          false,
        )
      }
    },
  )
  it('captures the current interface language for a new attempt after booking details change', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const api = fakeApi({
      ...eventRoutes({ ...EVENT, allowGuests: false }, ['2026-11-02T14:00:00Z']),
      'POST /api/v1/public/ada/intro/bookings': () => {
        if (++attempts === 1) throw new TypeError('lost response')
        return json(201, { booking: booking(), manageToken: TOKEN })
      },
    })
    renderApp('/ada/intro')
    await pick(user)
    await user.type(screen.getByLabelText('Your name'), 'Invitee')
    await user.type(screen.getByLabelText('Email'), 'invitee@example.invalid')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('alert')
    await setLanguage(user, 'zh-CN')
    await user.type(screen.getByLabelText('你的姓名'), ' changed')
    await user.click(screen.getByRole('button', { name: '确认预约' }))
    await screen.findByRole('heading', { name: '预约成功' })
    const [first, second] = api.to('POST /api/v1/public/ada/intro/bookings')
    expect(first?.body).toHaveProperty('invitee.locale', 'en-US')
    expect(second?.body).toHaveProperty('invitee.locale', 'zh-CN')
    expect(second?.body).toHaveProperty('invitee.name', 'Invitee changed')
    expect(second?.headers.get('idempotency-key')).not.toBe(first?.headers.get('idempotency-key'))
  })

  it('preserves the one-time confirmation capability and current booking through repeated language switches', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...eventRoutes({ ...EVENT, allowGuests: false }, ['2026-11-02T14:00:00Z']),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, { booking: booking(), manageToken: TOKEN }),
    })
    renderApp('/ada/intro')
    await pick(user)
    await user.type(screen.getByLabelText('Your name'), 'Synthetic invitee')
    await user.type(screen.getByLabelText('Email'), 'invitee@example.invalid')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    const link = screen.getByLabelText<HTMLInputElement>(
        'Your link to change or cancel this booking',
      ),
      value = link.value
    await setLanguage(user, 'zh-CN')
    expect(screen.getByLabelText('用于更改或取消此预约的链接')).toBe(link)
    expect(link.value === value).toBe(true)
    await setLanguage(user, 'en')
    expect(link.value === value).toBe(true)
    expect(api.to('POST /api/v1/public/ada/intro/bookings')).toHaveLength(1)
    expect(api.calls.every((call) => !call.path.includes(TOKEN))).toBe(true)
    expect(window.location.hash).toBe('')
  })
  it('preserves a reschedule selection, new manage capability and cancellation draft across language changes', async () => {
    const user = userEvent.setup()
    let current = managed()
    const api = fakeApi({
      'GET /api/v1/bookings/manage': () => json(200, current),
      'GET /api/v1/bookings/manage/slots': slotsAnswer(['2026-11-03T15:00:00Z']),
      'POST /api/v1/bookings/manage/reschedule': () => {
        current = { ...current, start: '2026-11-03T15:00:00.000Z', end: '2026-11-03T15:30:00.000Z' }
        return json(200, { booking: booking(current), manageToken: NEW_TOKEN })
      },
      'POST /api/v1/bookings/manage/cancel': () =>
        json(
          200,
          booking({ ...current, status: 'cancelled', cancelledAt: '2026-11-01T05:00:00Z' }),
        ),
    })
    window.history.replaceState(null, '', `/booking#token=${TOKEN}`)
    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>,
    )
    await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
    await user.click(await screen.findByRole('button', { name: /November 3, available/ }))
    await user.click(screen.getByRole('button', { name: '10:00 AM' }))
    await setLanguage(user, 'zh-CN')
    expect(screen.getByRole('heading', { name: '更改预约时间？' })).toBeDefined()
    expect(api.to('POST /api/v1/bookings/manage/reschedule')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '确认新时间' }))
    await screen.findByText('你的预约已改至新时间。')
    expect(
      screen.getByText(
        (_, node) =>
          node?.tagName === 'P' &&
          node.textContent ===
            '在日历中接受或拒绝邀请不会取消预约。如需取消，请使用此处的“取消预约”。',
      ),
    ).toBeDefined()
    expect(
      screen.getByText('没收到邮件？请检查垃圾邮件文件夹，并将发件人加入通讯录。'),
    ).toBeDefined()
    await setLanguage(user, 'en')
    expect(
      screen.getByText(
        'Accepting or declining the calendar invitation does not cancel the booking. To cancel, use “Cancel booking” here.',
      ),
    ).toBeDefined()
    expect(
      screen.getByText(
        'Didn’t get the email? Check spam or junk and add the sender to your contacts.',
      ),
    ).toBeDefined()
    await setLanguage(user, 'zh-CN')
    await user.click(screen.getByRole('button', { name: '取消预约' }))
    const reason = screen.getByLabelText<HTMLTextAreaElement>(/^原因/)
    await user.type(reason, 'Custom reason stays unchanged')
    await setLanguage(user, 'en')
    expect(screen.getByLabelText(/^Reason/)).toBe(reason)
    expect(reason.value).toBe('Custom reason stays unchanged')
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await screen.findByRole('heading', { name: 'Cancelled booking' })
    expect(
      screen.getByText(
        'Didn’t get the email? Check spam or junk and add the sender to your contacts.',
      ),
    ).toBeDefined()
    await setLanguage(user, 'zh-CN')
    expect(
      screen.getByText('没收到邮件？请检查垃圾邮件文件夹，并将发件人加入通讯录。'),
    ).toBeDefined()
    const cancel = api.to('POST /api/v1/bookings/manage/cancel')[0]
    expect(cancel?.headers.get('x-manage-token') === NEW_TOKEN).toBe(true)
    expect(cancel?.body).toEqual({ reason: 'Custom reason stays unchanged' })
    expect(window.location.hash).toBe('')
    expect(
      api.calls.every((call) => !call.path.includes(TOKEN) && !call.path.includes(NEW_TOKEN)),
    ).toBe(true)
    expect(api.to('GET /api/v1/me')).toHaveLength(0)
  })
  it('keeps an unsaved admin form, visible validation, custom title and leave guard in the selected language', async () => {
    const user = userEvent.setup(),
      confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      'POST /api/v1/event-types': (call) =>
        json(201, eventType({ ...(call.body as object), scheduleId: SCHEDULE_ID })),
    })
    renderApp('/app/event-types/new')
    const title = await screen.findByLabelText<HTMLInputElement>('Title')
    await user.type(title, 'Settings')
    await user.clear(screen.getByLabelText('Duration (minutes)'))
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Enter a number.')
    await setLanguage(user, 'zh-CN')
    expect(screen.getByLabelText('标题')).toBe(title)
    expect(title.value).toBe('Settings')
    expect(screen.getByRole('alert').textContent).toContain('请输入数字。')
    expect(document.getElementById('minimumNoticeMinutes-hint')?.textContent).toBe(
      '会议至少需要提前多久预约。0–525,600。',
    )
    await user.clear(screen.getByLabelText('最短提前预约时间（分钟）'))
    await user.type(screen.getByLabelText('最短提前预约时间（分钟）'), '1440')
    expect(document.getElementById('minimumNoticeMinutes-hint')?.textContent).toBe(
      '会议至少需要提前多久预约。0–525,600。= 1 天。',
    )
    expect(confirm).not.toHaveBeenCalled()
    await user.click(screen.getByRole('link', { name: '预约' }))
    expect(confirm).toHaveBeenCalledWith('你有未保存的更改。离开此页面并放弃更改？')
    expect(title.isConnected).toBe(true)
    expect(api.to('POST /api/v1/event-types')).toHaveLength(0)
  })
  it('maps an authenticated account default to a supported booking language without implicitly saving', async () => {
    const api = fakeApi({
      ...signedIn,
      ...profile({
        handle: 'ada',
        timeZone: 'Europe/Berlin',
        locale: 'zh-Hans-CN',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      }),
    })
    renderApp('/app/settings')
    await screen.findByRole('heading', { name: '设置', level: 1 })
    expect((await screen.findByLabelText<HTMLSelectElement>('预约语言')).value).toBe('zh-CN')
    const user = userEvent.setup()
    await setLanguage(user, 'en')
    expect(screen.getByLabelText<HTMLSelectElement>('Booking language').value).toBe('zh-CN')
    expect(api.to('PUT /api/v1/profile')).toHaveLength(0)
  })
  it('uses localized client validation for the sign-in email without relying on browser-native language', async () => {
    const user = userEvent.setup(),
      api = fakeApi({ ...signedOut, ...instance() })
    renderApp('/sign-in')
    const email = await screen.findByLabelText<HTMLInputElement>('Email')
    await user.type(email, 'invalid')
    await setLanguage(user, 'zh-CN')
    await user.click(screen.getByRole('button', { name: '通过邮件发送登录链接' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '请输入有效的邮箱地址，例如 name@example.com。',
    )
    expect(screen.getByLabelText('邮箱')).toBe(email)
    expect(email.value).toBe('invalid')
    expect(api.to('POST /api/auth/sign-in/magic-link')).toHaveLength(0)
  })
  it.each(['Email', 'Settings', 'Unknown service detail', '邮箱'])(
    'keeps unknown public server prose %s literal through the booking form boundary',
    async (detail) => {
      const user = userEvent.setup()
      const api = fakeApi({
        ...eventRoutes({ ...EVENT, allowGuests: false, questions: [] }, ['2026-11-02T14:00:00Z']),
        'POST /api/v1/public/ada/intro/bookings': () =>
          json(400, { error: 'unknown_future_code', message: detail }),
      })
      renderApp('/ada/intro')
      await pick(user)
      await user.type(screen.getByLabelText('Your name'), 'Synthetic invitee')
      await user.type(screen.getByLabelText('Email'), 'invitee@example.invalid')
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      const problem = await screen.findByRole('alert')
      expect(within(problem).getByText(detail, { selector: 'p' }).textContent).toBe(detail)
      await setLanguage(user, 'zh-CN')
      expect(screen.getByRole('alert')).toBe(problem)
      expect(within(problem).getByText(detail, { selector: 'p' }).textContent).toBe(detail)
      expect(screen.getByLabelText<HTMLInputElement>('你的姓名').value).toBe('Synthetic invitee')
      await setLanguage(user, 'en')
      expect(within(problem).getByText(detail, { selector: 'p' }).textContent).toBe(detail)
      expect(api.to('POST /api/v1/public/ada/intro/bookings')).toHaveLength(1)
    },
  )

  it('localizes a known server question error while keeping the custom question label and answer', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...eventRoutes(
        {
          ...EVENT,
          allowGuests: false,
          questions: [{ id: 'question', label: 'Settings', type: 'short_text', required: true }],
        },
        ['2026-11-02T14:00:00Z'],
      ),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(400, { error: 'invalid_responses', message: 'Question "question" is required' }),
    })
    renderApp('/ada/intro')
    await pick(user)
    await user.type(screen.getByLabelText('Your name'), 'Synthetic invitee')
    await user.type(screen.getByLabelText('Email'), 'invitee@example.invalid')
    await user.type(screen.getByLabelText('Settings'), 'Email')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByText('Check this answer.')
    await setLanguage(user, 'zh-CN')
    expect(screen.getByText('请检查此回答。')).toBeDefined()
    expect(screen.getByLabelText<HTMLInputElement>('Settings').value).toBe('Email')
    expect(screen.queryByText(/is required/)).toBeNull()
    await setLanguage(user, 'en')
    expect(screen.getByText('Check this answer.')).toBeDefined()
  })
})
