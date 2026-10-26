import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { goTo } from '../browser.ts'
import { translateMessage } from '../i18n/translate.ts'
import {
  emptyAccount,
  fakeApi,
  instance,
  json,
  later,
  organizations,
  renderApp,
  signedIn,
  signedOut,
} from '../test/fake-api.tsx'
import { describeSignInError } from './SignIn.tsx'

vi.mock('../browser.ts', () => ({ goTo: vi.fn() }))

const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty']

const location = () => screen.getByTestId('location').textContent
const heading = () => screen.findByRole('heading', { name: 'Sign in to Hourmere' })
const linkSent = () => json(200, { status: true })
const resendStatus = () => within(screen.getByRole('main')).getByRole('status')
/** Lets answered requests reach the page (for checking that something did not appear). */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))

const describeSignInErrorText = (...args: Parameters<typeof describeSignInError>) => {
  const result = describeSignInError(...args)
  return result === null ? null : translateMessage('en', result)
}
describe('the sign-in page', () => {
  it('requests a sign-in link and keeps its address and return path', async () => {
    const api = fakeApi({
      ...signedOut,
      ...instance(),
      'POST /api/auth/sign-in/magic-link': linkSent,
    })
    renderApp('/sign-in?next=%2Fapp%2Fapi-keys')
    await heading()
    const assertHeader = () => {
      const picker = screen.getByRole('combobox', { name: 'Interface language' })
      const header = picker.closest('header')
      expect(header?.classList.contains('card-header')).toBe(true)
      expect(header?.querySelector('.logo')?.textContent).toBe('Hourmere')
      expect(header?.parentElement?.classList.contains('card')).toBe(true)
      expect(screen.getAllByRole('combobox', { name: 'Interface language' })).toHaveLength(1)
    }
    assertHeader()
    await userEvent.type(screen.getByLabelText('Email'), ' ada@example.com ')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))

    const sent = await screen.findByRole('heading', { name: 'Check your email' })
    await waitFor(() => expect(document.activeElement).toBe(sent))
    assertHeader()
    expect(screen.getByText('ada@example.com')).toBeDefined()
    expect(
      screen.getByText(
        'Didn’t get the email? Check spam or junk and add the sender to your contacts.',
      ),
    ).toBeDefined()
    await userEvent.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(
      screen.getByText('没收到邮件？请检查垃圾邮件文件夹，并将发件人加入通讯录。'),
    ).toBeDefined()
    expect(screen.getByRole('button', { name: '重新发送链接' })).toBeDefined()
    expect(screen.getByRole('button', { name: '更换邮箱' })).toBeDefined()
    await userEvent.selectOptions(screen.getByLabelText('界面语言'), 'en')
    expect(api.to('POST /api/auth/sign-in/magic-link').map((c) => c.body)).toEqual([
      {
        email: 'ada@example.com',
        callbackURL: '/app/api-keys',
        errorCallbackURL: '/sign-in?next=%2Fapp%2Fapi-keys',
      },
    ])

    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))
    expect(await heading()).toBeDefined()
    const email = screen.getByLabelText<HTMLInputElement>('Email')
    expect(email.value).toBe('ada@example.com')
    expect(document.activeElement).toBe(email)
    expect(location()).toBe('/sign-in?next=%2Fapp%2Fapi-keys')
    expect(api.to('POST /api/auth/sign-in/magic-link')).toHaveLength(1)
    await userEvent.clear(email)
    await userEvent.type(email, ' grace@example.com ')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    await screen.findByRole('heading', { name: 'Check your email' })
    expect(screen.getByText('grace@example.com')).toBeDefined()
    expect(api.to('POST /api/auth/sign-in/magic-link')[1]?.body).toEqual({
      email: 'grace@example.com',
      callbackURL: '/app/api-keys',
      errorCallbackURL: '/sign-in?next=%2Fapp%2Fapi-keys',
    })
  })

  it('resends to the same email and return path without moving focus or returning to the form', async () => {
    const api = fakeApi({
      ...signedOut,
      ...instance(),
      'POST /api/auth/sign-in/magic-link': linkSent,
    })
    renderApp('/sign-in?next=%2Fapp%2Fsettings%3Ftab%3Dprofile')
    await userEvent.type(await screen.findByLabelText('Email'), ' ada@example.com ')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    const sent = await screen.findByRole('heading', { name: 'Check your email' })
    const resend = screen.getByRole('button', { name: 'Resend link' })

    await userEvent.click(resend)
    await waitFor(() =>
      expect(resendStatus().textContent).toBe(
        'We received your new sign-in link request. Check your inbox if this address can sign in.',
      ),
    )
    expect(screen.getByRole('heading', { name: 'Check your email' })).toBe(sent)
    expect(document.activeElement).toBe(resend)
    expect(resend.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByLabelText('Email')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(location()).toBe('/sign-in?next=%2Fapp%2Fsettings%3Ftab%3Dprofile')
    expect(api.to('POST /api/auth/sign-in/magic-link').map((call) => call.body)).toEqual([
      {
        email: 'ada@example.com',
        callbackURL: '/app/settings?tab=profile',
        errorCallbackURL: '/sign-in?next=%2Fapp%2Fsettings%3Ftab%3Dprofile',
      },
      {
        email: 'ada@example.com',
        callbackURL: '/app/settings?tab=profile',
        errorCallbackURL: '/sign-in?next=%2Fapp%2Fsettings%3Ftab%3Dprofile',
      },
    ])
  })

  it.each(['body', 'language picker'])(
    'restores only lost resend focus when focus is on the %s after native button disabling',
    async (target) => {
      const pending = later()
      let requests = 0
      fakeApi({
        ...signedOut,
        ...instance(),
        'POST /api/auth/sign-in/magic-link': () =>
          ++requests === 1 ? linkSent() : pending.response,
      })
      renderApp('/sign-in')
      await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com')
      await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
      const resend = await screen.findByRole('button', { name: 'Resend link' })
      await userEvent.click(resend)
      expect(resend.hasAttribute('disabled')).toBe(true)
      const picker = screen.getByRole('combobox', { name: 'Interface language' })
      if (target === 'body') {
        // JSDOM keeps focus on disabled buttons; simulate Chrome moving it to the body.
        document.body.tabIndex = -1
        document.body.focus()
        document.body.removeAttribute('tabindex')
      } else {
        picker.focus()
      }
      expect(document.activeElement).toBe(target === 'body' ? document.body : picker)

      await pending.answer(linkSent())
      expect(resend.hasAttribute('disabled')).toBe(false)
      expect(resendStatus().textContent).toMatch(/new sign-in link request/)
      expect(document.activeElement).toBe(target === 'body' ? resend : picker)
    },
  )

  it('clears previous resend feedback when changing email and submitting a fresh request', async () => {
    const api = fakeApi({
      ...signedOut,
      ...instance(),
      'POST /api/auth/sign-in/magic-link': linkSent,
    })
    renderApp('/sign-in?next=%2Fapp%2Fsettings')
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Resend link' }))
    await waitFor(() => expect(resendStatus().textContent).toMatch(/new sign-in link request/))

    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))
    const email = await screen.findByLabelText<HTMLInputElement>('Email')
    expect(email.value).toBe('ada@example.com')
    await userEvent.clear(email)
    await userEvent.type(email, 'grace@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    await screen.findByRole('heading', { name: 'Check your email' })

    expect(screen.getByText('grace@example.com')).toBeDefined()
    expect(resendStatus().textContent).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.to('POST /api/auth/sign-in/magic-link')[2]?.body).toEqual({
      email: 'grace@example.com',
      callbackURL: '/app/settings',
      errorCallbackURL: '/sign-in?next=%2Fapp%2Fsettings',
    })
  })

  it('sends one resend request for a double click and disables both actions while it is pending', async () => {
    const pending = later()
    let requests = 0
    const api = fakeApi({
      ...signedOut,
      ...instance(),
      'POST /api/auth/sign-in/magic-link': () => (++requests === 1 ? linkSent() : pending.response),
    })
    renderApp('/sign-in')
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    const sent = await screen.findByRole('heading', { name: 'Check your email' })
    const resend = screen.getByRole('button', { name: 'Resend link' })
    await userEvent.dblClick(resend)

    expect(api.to('POST /api/auth/sign-in/magic-link')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Resend link' })).toBe(resend)
    expect(resend.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Change email' }).hasAttribute('disabled')).toBe(true)
    expect(resendStatus().textContent).toBe('Resending…')
    expect(screen.getByRole('heading', { name: 'Check your email' })).toBe(sent)
    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))
    expect(screen.queryByLabelText('Email')).toBeNull()

    await pending.answer(linkSent())
    expect(api.to('POST /api/auth/sign-in/magic-link')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Resend link' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'Change email' }).hasAttribute('disabled')).toBe(
      false,
    )
    expect(document.activeElement).toBe(resend)
  })

  it('also guards two resend clicks dispatched before the busy state renders', async () => {
    const pending = later()
    let requests = 0
    const api = fakeApi({
      ...signedOut,
      ...instance(),
      'POST /api/auth/sign-in/magic-link': () => (++requests === 1 ? linkSent() : pending.response),
    })
    renderApp('/sign-in')
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    const resend = await screen.findByRole('button', { name: 'Resend link' })
    act(() => {
      fireEvent.click(resend)
      fireEvent.click(resend)
    })
    await settle()
    expect(api.to('POST /api/auth/sign-in/magic-link')).toHaveLength(2)
    await pending.answer(linkSent())
  })

  it('keeps the sent screen when Change email is clicked before a pending resend renders', async () => {
    const pending = later()
    let requests = 0
    const api = fakeApi({
      ...signedOut,
      ...instance(),
      'POST /api/auth/sign-in/magic-link': () => (++requests === 1 ? linkSent() : pending.response),
    })
    renderApp('/sign-in?next=%2Fapp%2Fbookings')
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    const sent = await screen.findByRole('heading', { name: 'Check your email' })
    const resend = screen.getByRole('button', { name: 'Resend link' })
    const change = screen.getByRole('button', { name: 'Change email' })
    act(() => {
      fireEvent.click(resend)
      fireEvent.click(change)
    })
    await settle()

    expect(api.to('POST /api/auth/sign-in/magic-link')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'Check your email' })).toBe(sent)
    expect(screen.queryByLabelText('Email')).toBeNull()
    expect(resendStatus().textContent).toBe('Resending…')
    expect(change.hasAttribute('disabled')).toBe(true)
    await pending.answer(linkSent())
    expect(screen.getByRole('heading', { name: 'Check your email' })).toBe(sent)
    expect(resendStatus().textContent).toMatch(/new sign-in link request/)
    expect(location()).toBe('/sign-in?next=%2Fapp%2Fbookings')
  })

  it('explains a server resend rate limit without inventing a waiting time and allows retry', async () => {
    let requests = 0
    const api = fakeApi({
      ...signedOut,
      ...instance(),
      'POST /api/auth/sign-in/magic-link': () => (++requests === 2 ? json(429, {}) : linkSent()),
    })
    renderApp('/sign-in?next=%2Fapp%2Fbookings')
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Resend link' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many requests. Please wait and try again later.',
    )
    expect(screen.getByRole('heading', { name: 'Check your email' })).toBeDefined()
    expect(screen.getByText('ada@example.com')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Resend link' }).hasAttribute('disabled')).toBe(false)
    expect(location()).toBe('/sign-in?next=%2Fapp%2Fbookings')
    await userEvent.click(screen.getByRole('button', { name: 'Resend link' }))
    await waitFor(() => expect(resendStatus().textContent).toMatch(/new sign-in link request/))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.to('POST /api/auth/sign-in/magic-link')).toHaveLength(3)
    expect(api.to('POST /api/auth/sign-in/magic-link')[2]?.body).toEqual({
      email: 'ada@example.com',
      callbackURL: '/app/bookings',
      errorCallbackURL: '/sign-in?next=%2Fapp%2Fbookings',
    })
  })

  it.each(['network', 'server'])(
    'allows retry after a %s resend failure with the same email and return path',
    async (failure) => {
      let requests = 0
      const api = fakeApi({
        ...signedOut,
        ...instance(),
        'POST /api/auth/sign-in/magic-link': () => {
          if (++requests !== 2) return linkSent()
          if (failure === 'network') throw new TypeError('Failed to fetch')
          return json(503, { message: 'Service unavailable' })
        },
      })
      renderApp('/sign-in?next=%2Fapp%2Fapi-keys')
      await userEvent.type(await screen.findByLabelText('Email'), ' ada@example.com ')
      await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
      const sent = await screen.findByRole('heading', { name: 'Check your email' })
      await userEvent.click(screen.getByRole('button', { name: 'Resend link' }))

      expect((await screen.findByRole('alert')).textContent).toBe(
        'Could not resend the link. Please try again.',
      )
      expect(screen.getByRole('heading', { name: 'Check your email' })).toBe(sent)
      expect(screen.getByText('ada@example.com')).toBeDefined()
      expect(screen.queryByLabelText('Email')).toBeNull()
      expect(location()).toBe('/sign-in?next=%2Fapp%2Fapi-keys')
      const resend = screen.getByRole('button', { name: 'Resend link' })
      expect(resend.hasAttribute('disabled')).toBe(false)
      await userEvent.click(resend)
      await waitFor(() => expect(resendStatus().textContent).toMatch(/new sign-in link request/))
      expect(screen.queryByRole('alert')).toBeNull()
      expect(document.activeElement).toBe(resend)
      expect(api.to('POST /api/auth/sign-in/magic-link').map((call) => call.body)).toEqual(
        Array.from({ length: 3 }, () => ({
          email: 'ada@example.com',
          callbackURL: '/app/api-keys',
          errorCallbackURL: '/sign-in?next=%2Fapp%2Fapi-keys',
        })),
      )
    },
  )

  it('localizes resend progress, success, rate limits and retryable failures into Chinese', async () => {
    const pending = later()
    let requests = 0
    fakeApi({
      ...signedOut,
      ...instance(),
      'POST /api/auth/sign-in/magic-link': () => {
        requests++
        if (requests === 2) return pending.response
        if (requests === 3) return json(429, {})
        if (requests === 4) throw new TypeError('Failed to fetch')
        return linkSent()
      },
    })
    renderApp('/sign-in')
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    await screen.findByRole('heading', { name: 'Check your email' })
    await userEvent.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    await userEvent.click(screen.getByRole('button', { name: '重新发送链接' }))
    expect(screen.getByRole('button', { name: '重新发送链接' }).hasAttribute('disabled')).toBe(true)
    expect(resendStatus().textContent).toBe('正在重新发送…')
    await pending.answer(linkSent())
    expect(resendStatus().textContent).toBe(
      '我们已收到新的登录链接请求。如果此邮箱可以登录，请检查收件箱。',
    )
    await userEvent.click(screen.getByRole('button', { name: '重新发送链接' }))
    expect((await screen.findByRole('alert')).textContent).toBe('请求过多，请稍后重试。')
    await userEvent.click(screen.getByRole('button', { name: '重新发送链接' }))
    expect((await screen.findByRole('alert')).textContent).toBe('无法重新发送链接，请重试。')
    expect(screen.getByRole('button', { name: '更换邮箱' })).toBeDefined()
  })

  it('shows only email sign-in when no provider is enabled', async () => {
    const api = fakeApi({ ...signedOut, ...instance() })
    renderApp('/sign-in')
    await heading()
    await vi.waitFor(() => expect(api.to('GET /api/v1/instance')).toHaveLength(1))
    await settle()
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /continue with/i })).toBeNull()
    expect(screen.queryByText(/Google sign-in shares/)).toBeNull()
    expect(screen.queryByText(/Use a personal Microsoft account/)).toBeNull()
  })

  it('shows the providers the instance has enabled, and only those', async () => {
    fakeApi({ ...signedOut, ...instance({ google: true }) })
    renderApp('/sign-in')
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Sign in with Microsoft' })).toBeNull()
    expect(screen.queryByText(/Use a personal Microsoft account/)).toBeNull()
  })

  it('explains Google identity access separately from calendars before starting sign-in', async () => {
    const api = fakeApi({
      ...signedOut,
      ...instance({ google: true }),
      'POST /api/auth/sign-in/social': () =>
        json(200, { url: 'https://accounts.google.com/authorize', redirect: true }),
    })
    renderApp('/sign-in')
    const button = await screen.findByRole('button', { name: 'Continue with Google' })
    expect(
      screen.getByText(/Google sign-in shares your name, email and profile picture/).textContent,
    ).toBe(
      'Google sign-in shares your name, email and profile picture with Hourmere. Calendar access is a separate, optional step in Calendars.',
    )
    expect(button.getAttribute('aria-describedby')).toBe('google-sign-in-explanation')
    expect(api.to('POST /api/auth/sign-in/social')).toHaveLength(0)
    await userEvent.click(button)
    await vi.waitFor(() =>
      expect(goTo).toHaveBeenCalledWith('https://accounts.google.com/authorize'),
    )
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.textContent?.trim()).toBe('Continue with Google')
  })

  it('uses Google’s approved Chinese wording and localizes the sign-in explanation', async () => {
    fakeApi({ ...signedOut, ...instance({ google: true, microsoft: true }) })
    renderApp('/sign-in')
    await screen.findByRole('button', { name: 'Continue with Google' })
    await userEvent.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(screen.getByRole('button', { name: '继续使用 Google' })).toBeDefined()
    expect(screen.getByRole('button', { name: '使用 Microsoft 登录' })).toBeDefined()
    expect(screen.getByText('使用个人 Microsoft 账号或工作或学校账号。')).toBeDefined()
    const explanation = document.getElementById('google-sign-in-explanation')
    expect(explanation?.textContent).toBe(
      '通过 Google 登录会向 Hourmere 提供你的姓名、邮箱和头像。日历访问是独立的可选步骤，可在“日历”页面连接。',
    )
    expect(explanation?.querySelectorAll('.cjk-quote')).toHaveLength(2)
  })

  it('does not guess the providers when the instance cannot say', async () => {
    const api = fakeApi({
      ...signedOut,
      'GET /api/v1/instance': () => json(500, { error: 'internal_error' }),
    })
    renderApp('/sign-in')
    await heading()
    await vi.waitFor(() => expect(api.to('GET /api/v1/instance')).toHaveLength(1))
    await settle()
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /continue with/i })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('sends the browser to the provider', async () => {
    const api = fakeApi({
      ...signedOut,
      ...instance({ google: true, microsoft: true }),
      'POST /api/auth/sign-in/social': () =>
        json(200, { url: 'https://login.microsoftonline.com/authorize?x=1', redirect: true }),
    })
    renderApp('/sign-in?next=%2Fapp%2Fbookings')
    expect(
      await screen.findByText('Use a personal Microsoft account or a work or school account.'),
    ).toBeDefined()
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Microsoft' }))
    await vi.waitFor(() =>
      expect(goTo).toHaveBeenCalledWith('https://login.microsoftonline.com/authorize?x=1'),
    )
    expect(api.to('POST /api/auth/sign-in/social').map((c) => c.body)).toEqual([
      {
        provider: 'microsoft',
        callbackURL: '/app/bookings',
        errorCallbackURL: '/sign-in?next=%2Fapp%2Fbookings',
      },
    ])
  })

  it('explains a failed sign-in link and clears the error from the address', async () => {
    fakeApi({ ...signedOut, ...instance() })
    renderApp('/sign-in?next=%2Fapp%2Fsettings&error=INVALID_TOKEN')
    expect((await screen.findByRole('alert')).textContent).toMatch(/link is invalid, has expired/)
    await vi.waitFor(() => expect(location()).toBe('/sign-in?next=%2Fapp%2Fsettings'))
  })

  it('never shows the error description from the address (anyone can write it)', async () => {
    fakeApi({ ...signedOut, ...instance() })
    renderApp('/sign-in?error=access_denied&error_description=Call+support+at+555-0100')
    expect((await screen.findByRole('alert')).textContent).toBe('Sign-in was cancelled.')
    expect(screen.getByRole('main').textContent).not.toContain('555-0100')
    await vi.waitFor(() => expect(location()).toBe('/sign-in'))
  })

  it.each(PROTOTYPE_KEYS)('shows the page for ?error=%s', async (code) => {
    fakeApi({ ...signedOut, ...instance() })
    renderApp(`/sign-in?next=%2Fapp%2Fsettings&error=${code}`)
    expect((await screen.findByRole('alert')).textContent).toBe(
      `Sign-in did not work (${code}). Please try again.`,
    )
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeDefined()
    await vi.waitFor(() => expect(location()).toBe('/sign-in?next=%2Fapp%2Fsettings'))
  })

  it('reports a rate limit when sending the link', async () => {
    fakeApi({
      ...signedOut,
      ...instance(),
      'POST /api/auth/sign-in/magic-link': () => json(429, {}),
    })
    renderApp('/sign-in')
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not send the link. Too many requests. Wait a minute and try again.',
    )
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe('ada@example.com')
  })

  it('sends people who are already signed in on to where they were going', async () => {
    fakeApi({
      ...signedIn,
      ...organizations(),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
    })
    renderApp('/sign-in?next=%2Fapp%2Fapi-keys')
    expect(await screen.findByRole('heading', { name: 'API keys', level: 1 })).toBeDefined()
    expect(location()).toBe('/app/api-keys')
  })

  it('sends signed-in people to the default page instead of an old or public address', async () => {
    fakeApi({ ...signedIn, ...emptyAccount })
    renderApp('/sign-in?next=%2Fapi-keys')
    expect(await screen.findByRole('heading', { name: 'Event types', level: 1 })).toBeDefined()
    expect(location()).toBe('/app/event-types')
  })

  it('signs in back to the default page for a destination outside the app', async () => {
    const api = fakeApi({
      ...signedOut,
      ...instance(),
      'POST /api/auth/sign-in/magic-link': linkSent,
    })
    renderApp('/sign-in?next=%2Fada%2Fintro-call')
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    await screen.findByRole('heading', { name: 'Check your email' })
    expect(api.to('POST /api/auth/sign-in/magic-link')[0]?.body).toMatchObject({
      callbackURL: '/app',
      errorCallbackURL: '/sign-in',
    })
  })

  it('ignores a destination on another site', async () => {
    const api = fakeApi({
      ...signedOut,
      ...instance(),
      'POST /api/auth/sign-in/magic-link': linkSent,
    })
    renderApp('/sign-in?next=%2F%2Fevil.example%2Fphish')
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    await screen.findByRole('heading', { name: 'Check your email' })
    expect(api.to('POST /api/auth/sign-in/magic-link')[0]?.body).toMatchObject({
      callbackURL: '/app',
      errorCallbackURL: '/sign-in',
    })
  })

  it('sends signed-in people to the default page instead of another site', async () => {
    fakeApi({ ...signedIn, ...emptyAccount })
    renderApp('/sign-in?next=https%3A%2F%2Fevil.example')
    expect(await screen.findByRole('heading', { name: 'Event types', level: 1 })).toBeDefined()
    expect(location()).toBe('/app/event-types')
  })
})

describe('describeSignInError', () => {
  it('names unknown codes only when they look like codes', () => {
    expect(describeSignInErrorText(null)).toBeNull()
    expect(describeSignInErrorText('EMAIL_NOT_VERIFIED')).toMatch(/did not confirm your email/)
    expect(describeSignInErrorText('something_new')).toBe(
      'Sign-in did not work (something_new). Please try again.',
    )
    expect(describeSignInErrorText('Visit evil.example to fix your account now')).toBe(
      'Sign-in did not work. Please try again.',
    )
  })

  it.each([
    ['failed_to_create_user', 'Your account could not be created. Please try again.'],
    ['unable_to_create_user', 'Your account could not be created. Please try again.'],
    ['failed_to_create_session', 'You could not be signed in. Please try again.'],
    ['unable_to_create_session', 'You could not be signed in. Please try again.'],
    ['email_does_not_match', /email address does not match yours/],
    ['account_already_linked_to_different_user', /already connected to another Hourmere account/],
    ['unable_to_get_user_info', /did not send your account details/],
    [
      'SIGNUP_DISABLED',
      'This Hourmere instance does not accept new accounts for that email address.',
    ],
  ])('explains %s', (code, message) => {
    if (typeof message === 'string') expect(describeSignInErrorText(code)).toBe(message)
    else expect(describeSignInErrorText(code)).toMatch(message)
  })

  it.each(PROTOTYPE_KEYS)('treats %s as an unknown code, not an inherited property', (code) => {
    expect(describeSignInErrorText(code)).toBe(`Sign-in did not work (${code}). Please try again.`)
  })
})
