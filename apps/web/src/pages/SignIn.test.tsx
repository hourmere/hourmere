import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { goTo } from '../browser.ts'
import { translateMessage } from '../i18n/translate.ts'
import {
  emptyAccount,
  fakeApi,
  instance,
  json,
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
    expect(screen.getByRole('button', { name: '使用其他邮箱或重试' })).toBeDefined()
    await userEvent.selectOptions(screen.getByLabelText('界面语言'), 'en')
    expect(api.to('POST /api/auth/sign-in/magic-link').map((c) => c.body)).toEqual([
      {
        email: 'ada@example.com',
        callbackURL: '/app/api-keys',
        errorCallbackURL: '/sign-in?next=%2Fapp%2Fapi-keys',
      },
    ])

    await userEvent.click(
      screen.getByRole('button', { name: 'Use a different email or try again' }),
    )
    expect(await heading()).toBeDefined()
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
