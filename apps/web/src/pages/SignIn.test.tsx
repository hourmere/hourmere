import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { goTo } from '../browser.ts'
import {
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

describe('the sign-in page', () => {
  it('emails a sign-in link and says where it went', async () => {
    const api = fakeApi({
      ...signedOut,
      ...instance(),
      'POST /api/auth/sign-in/magic-link': linkSent,
    })
    renderApp('/sign-in?next=%2Fapi-keys')
    await heading()
    await userEvent.type(screen.getByLabelText('Email'), ' ada@example.com ')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))

    const sent = await screen.findByRole('heading', { name: 'Check your email' })
    expect(document.activeElement).toBe(sent)
    expect(screen.getByText('ada@example.com')).toBeDefined()
    expect(api.to('POST /api/auth/sign-in/magic-link').map((c) => c.body)).toEqual([
      {
        email: 'ada@example.com',
        callbackURL: '/api-keys',
        errorCallbackURL: '/sign-in?next=%2Fapi-keys',
      },
    ])

    await userEvent.click(screen.getByRole('button', { name: 'Use a different email' }))
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
  })

  it('shows the providers the instance has enabled, and only those', async () => {
    fakeApi({ ...signedOut, ...instance({ google: true }) })
    renderApp('/sign-in')
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Continue with Microsoft' })).toBeNull()
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
    renderApp('/sign-in?next=%2Fbookings')
    await userEvent.click(await screen.findByRole('button', { name: 'Continue with Microsoft' }))
    await vi.waitFor(() =>
      expect(goTo).toHaveBeenCalledWith('https://login.microsoftonline.com/authorize?x=1'),
    )
    expect(api.to('POST /api/auth/sign-in/social').map((c) => c.body)).toEqual([
      {
        provider: 'microsoft',
        callbackURL: '/bookings',
        errorCallbackURL: '/sign-in?next=%2Fbookings',
      },
    ])
  })

  it('explains a failed sign-in link and clears the error from the address', async () => {
    fakeApi({ ...signedOut, ...instance() })
    renderApp('/sign-in?next=%2Fsettings&error=INVALID_TOKEN')
    expect((await screen.findByRole('alert')).textContent).toMatch(/link is invalid, has expired/)
    await vi.waitFor(() => expect(location()).toBe('/sign-in?next=%2Fsettings'))
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
    renderApp(`/sign-in?next=%2Fsettings&error=${code}`)
    expect((await screen.findByRole('alert')).textContent).toBe(
      `Sign-in did not work (${code}). Please try again.`,
    )
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeDefined()
    await vi.waitFor(() => expect(location()).toBe('/sign-in?next=%2Fsettings'))
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
    renderApp('/sign-in?next=%2Fapi-keys')
    expect(await screen.findByRole('heading', { name: 'API keys', level: 1 })).toBeDefined()
    expect(location()).toBe('/api-keys')
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
      callbackURL: '/',
      errorCallbackURL: '/sign-in',
    })
  })

  it('sends signed-in people to the start page instead of another site', async () => {
    fakeApi(signedIn)
    renderApp('/sign-in?next=https%3A%2F%2Fevil.example')
    expect(await screen.findByRole('heading', { name: 'Event types', level: 1 })).toBeDefined()
    expect(location()).toBe('/event-types')
  })
})

describe('describeSignInError', () => {
  it('names unknown codes only when they look like codes', () => {
    expect(describeSignInError(null)).toBeNull()
    expect(describeSignInError('EMAIL_NOT_VERIFIED')).toMatch(/did not confirm your email/)
    expect(describeSignInError('something_new')).toBe(
      'Sign-in did not work (something_new). Please try again.',
    )
    expect(describeSignInError('Visit evil.example to fix your account now')).toBe(
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
    ['SIGNUP_DISABLED', 'New accounts cannot be created on this instance.'],
  ])('explains %s', (code, message) => {
    if (typeof message === 'string') expect(describeSignInError(code)).toBe(message)
    else expect(describeSignInError(code)).toMatch(message)
  })

  it.each(PROTOTYPE_KEYS)('treats %s as an unknown code, not an inherited property', (code) => {
    expect(describeSignInError(code)).toBe(`Sign-in did not work (${code}). Please try again.`)
  })
})
