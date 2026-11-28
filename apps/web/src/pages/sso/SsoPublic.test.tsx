import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { App } from '../../App.tsx'
import { goTo, replaceWith } from '../../browser.ts'
import { MailboxProofPage, SessionLayout, SignInPage } from '../../lazy-pages.tsx'
import { PATHS } from '../../paths.ts'
import { fakeApi, json, later, renderApp, signedOut } from '../../test/fake-api.tsx'
import { resolveLazy } from '../../test/resolve-lazy.ts'

vi.mock('../../browser.ts', () => ({ goTo: vi.fn(), replaceWith: vi.fn() }))

beforeAll(() => resolveLazy(SessionLayout, SignInPage, MailboxProofPage))

const providerId = '00000000-0000-7000-8000-000000000010'
const secondProviderId = '00000000-0000-7000-8000-000000000011'
const attemptId = '00000000-0000-7000-8000-000000000020'
const token = 'x'.repeat(43)
const signIn = `${PATHS.signIn}?sso=${providerId}&next=%2Fapp%2Fsettings`
const samlSignIn = `${signIn}&saml=1`
const proof = `${PATHS.mailboxProof}#attempt=${attemptId}`
const emailedLink = `${proof}&token=${token}`
const authorization = 'https://identity.example/authorize'
const genericOutcome =
  'To continue, sign in with your usual method or use a current team invitation.'
const linkError = 'Could not verify that link. Check the link or request a new email.'
const unavailable = 'Identity verification is unavailable.'

const start = 'POST /api/auth/sign-in/sso'
const send = 'POST /api/auth/sso/mailbox-proof/send'
const consume = 'POST /api/auth/sso/mailbox-proof/consume'
const complete = 'POST /api/auth/sso/oidc/complete'
const ssoButtonName = 'Sign in with single sign-on'

afterEach(() => sessionStorage.clear())

function instance(ssoOidcEnabled = true, ssoSamlEnabled = false) {
  return json(200, {
    ssoOidcEnabled,
    ssoSamlEnabled,
    signIn: { email: true, google: true, microsoft: false },
  })
}

function redirectedTo(path: string) {
  const response = new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
  // Fetch follows Location but removes its fragment before exposing the response URL.
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: new URL(path.split('#')[0] ?? '', window.location.origin).href },
  })
  return response
}

function FragmentIndicator() {
  const { hash } = useLocation()
  return <output aria-label="Fragment state">{hash ? 'Present' : 'Cleared'}</output>
}

function testRouter(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <Link to={`${PATHS.signIn}?sso=${secondProviderId}`}>Switch sign-in link</Link>
      <Link to={signIn}>Open OIDC sign-in link</Link>
      <Link to={emailedLink}>Open verification link</Link>
      <FragmentIndicator />
    </MemoryRouter>,
  )
}

describe('public SSO sign-in', () => {
  it('makes only the existing requests when SSO is off, including with a provider in the URL', async () => {
    const api = fakeApi({
      ...signedOut,
      'GET /api/v1/instance': () => instance(false),
      'POST /api/auth/sign-in/magic-link': () => json(200, { status: true }),
    })
    const fetch = vi.spyOn(globalThis, 'fetch')
    const user = userEvent.setup()
    testRouter(signIn)
    await screen.findByRole('button', { name: 'Continue with Google' })
    expect(screen.queryByRole('button', { name: 'Sign in with single sign-on' })).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)

    await user.type(screen.getByLabelText('Email'), 'person@example.com')
    await user.click(screen.getByRole('link', { name: 'Switch sign-in link' }))
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe('person@example.com')
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    await screen.findByRole('heading', { name: 'Check your email' })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(api.calls.map(({ method, path }) => `${method} ${path}`).sort()).toEqual([
      'GET /api/v1/instance',
      'GET /api/v1/me',
      'POST /api/auth/sign-in/magic-link',
    ])
    expect(api.to('POST /api/auth/sign-in/magic-link')[0]?.body).toEqual({
      email: 'person@example.com',
      callbackURL: '/app',
      errorCallbackURL: '/sign-in',
    })
  })

  it('starts the named provider only after consent and keeps personal sign-in choices', async () => {
    const api = fakeApi({
      ...signedOut,
      'GET /api/v1/instance': () => instance(),
      [start]: () => json(200, { redirect: true, url: authorization }),
    })
    renderApp(signIn)
    const button = await screen.findByRole('button', { name: 'Sign in with single sign-on' })
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeDefined()
    expect(api.to(start)).toEqual([])
    await userEvent.click(button)
    await waitFor(() => expect(goTo).toHaveBeenCalledWith(authorization))
    expect(api.to(start).map(({ body }) => body)).toEqual([
      { providerId, intent: 'sign_in', returnTo: '/app/settings' },
    ])
  })

  it('keeps the OIDC sign-in link available while a direct SAML link shows only personal choices', async () => {
    const api = fakeApi({
      ...signedOut,
      'GET /api/v1/instance': () => instance(),
    })
    const user = userEvent.setup()
    testRouter(samlSignIn)
    await screen.findByRole('button', { name: 'Continue with Google' })
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeDefined()
    expect(screen.queryByRole('button', { name: ssoButtonName })).toBeNull()
    const language = screen.getByRole('combobox', { name: 'Interface language' })
    expect(within(language).getAllByRole('option')).toHaveLength(2)
    await user.click(screen.getByRole('link', { name: 'Open OIDC sign-in link' }))
    await screen.findByRole('button', { name: ssoButtonName })
    expect(within(language).getAllByRole('option')).toHaveLength(2)
    expect(api.to(start)).toEqual([])
  })

  it.each([403, 503])(
    'keeps SAML unavailable while instance readiness loads or returns %i',
    async (status) => {
      const readiness = later()
      const api = fakeApi({ ...signedOut, 'GET /api/v1/instance': () => readiness.response })
      renderApp(samlSignIn)
      await screen.findByRole('button', { name: 'Email me a sign-in link' })
      expect(screen.queryByRole('button', { name: ssoButtonName })).toBeNull()
      await readiness.answer(json(status, { error: 'unavailable' }))
      expect(screen.queryByRole('button', { name: ssoButtonName })).toBeNull()
      expect(api.to(start)).toEqual([])
    },
  )

  it.each([
    ['en', 'Sign in with single sign-on'],
    ['zh-CN', '使用单点登录'],
    ['de', 'Mit Single Sign-on anmelden'],
    ['es', 'Acceder con inicio de sesión único'],
    ['fr', 'Se connecter avec l’authentification unique'],
    ['pt-BR', 'Entrar com login único'],
  ])('starts SAML with OIDC off using the public %s sign-in text', async (locale, label) => {
    const api = fakeApi({
      ...signedOut,
      'GET /api/v1/instance': () => instance(false, true),
      [start]: () => json(200, { redirect: true, url: authorization }),
    })
    const user = userEvent.setup()
    renderApp(samlSignIn)
    await screen.findByRole('button', { name: ssoButtonName })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Interface language' }), locale)
    const button = await screen.findByRole('button', { name: label })
    expect(document.documentElement.lang).toBe(locale)
    expect(api.to(start)).toEqual([])
    await user.click(button)
    await waitFor(() => expect(goTo).toHaveBeenCalledWith(authorization))
    expect(api.to(start).map(({ body }) => body)).toEqual([
      { providerId, intent: 'sign_in', returnTo: PATHS.settings },
    ])
  })

  it('discards a pending SAML handoff when switching protocol for the same provider and destination', async () => {
    const pending = later()
    const api = fakeApi({
      ...signedOut,
      'GET /api/v1/instance': () => instance(true, true),
      [start]: () => pending.response,
    })
    const user = userEvent.setup()
    testRouter(samlSignIn)
    await user.click(await screen.findByRole('button', { name: ssoButtonName }))
    await waitFor(() => expect(api.to(start)).toHaveLength(1))
    await user.click(screen.getByRole('link', { name: 'Open OIDC sign-in link' }))
    await pending.answer(json(200, { redirect: true, url: authorization }))
    expect(goTo).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: ssoButtonName }).disabled).toBe(
      false,
    )
  })

  it('reports an unavailable SAML provider without exposing private response details', async () => {
    const api = fakeApi({
      ...signedOut,
      'GET /api/v1/instance': () => instance(false, true),
      [start]: () => json(403, { error: 'forbidden', message: 'Private response detail' }),
    })
    renderApp(samlSignIn)
    await userEvent.click(await screen.findByRole('button', { name: ssoButtonName }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Single sign-on is unavailable. Try again or use another sign-in method.',
    )
    expect(api.to(start)).toHaveLength(1)
    expect(goTo).not.toHaveBeenCalled()
  })

  it('ignores a late redirect after the sign-in link or its destination changes', async () => {
    const pending = later()
    const api = fakeApi({
      ...signedOut,
      'GET /api/v1/instance': () => instance(),
      [start]: ({ body }) =>
        (body as { providerId: string }).providerId === providerId
          ? pending.response
          : json(403, { error: 'forbidden', message: 'Private response detail' }),
    })
    const user = userEvent.setup()
    testRouter(signIn)
    await user.click(await screen.findByRole('button', { name: 'Sign in with single sign-on' }))
    await waitFor(() => expect(api.to(start)).toHaveLength(1))
    await user.click(screen.getByRole('link', { name: 'Switch sign-in link' }))
    await pending.answer(json(200, { redirect: true, url: authorization }))
    expect(goTo).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Sign in with single sign-on' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Single sign-on is unavailable. Try again or use another sign-in method.',
    )
    expect(api.to(start).at(-1)?.body).toEqual({
      providerId: secondProviderId,
      intent: 'sign_in',
      returnTo: PATHS.home,
    })
  })

  it('restores sign-in choices when the browser returns from the provider via its back cache', async () => {
    fakeApi({
      ...signedOut,
      'GET /api/v1/instance': () => instance(),
      [start]: () => json(200, { redirect: true, url: authorization }),
    })
    renderApp(signIn)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Sign in with single sign-on' }),
    )
    await waitFor(() => expect(goTo).toHaveBeenCalledWith(authorization))
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Opening single sign-on…' }).disabled,
    ).toBe(true)
    act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in with single sign-on' })
        .disabled,
    ).toBe(false)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Email me a sign-in link' }).disabled,
    ).toBe(false)
  })
})

describe('SSO mailbox proof', () => {
  const verify = 'Verify email link'
  const verified = 'Email verification complete.'
  const sendEmail = 'Send verification email'

  it('does not offer SAML mailbox continuation while OIDC alone is enabled', async () => {
    const api = fakeApi({ 'GET /api/v1/instance': () => instance() })
    renderApp(`${proof}&saml=1`)
    await screen.findByText(unavailable)
    expect(screen.queryByRole('button', { name: sendEmail })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(api.to(send)).toEqual([])
  })

  it('uses the SAML completion form after proving a changed mailbox with OIDC off', async () => {
    const api = fakeApi({
      'GET /api/v1/instance': () => json(200, { ssoOidcEnabled: false, ssoSamlEnabled: true }),
      [send]: () => json(200, { status: 'queued' }),
      [consume]: () => json(200, { status: 'proven' }),
    })
    const fetchApi = globalThis.fetch
    const completeSaml = vi.fn(() => redirectedTo(PATHS.settings))
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/auth/sso/saml2/complete') {
        expect(init?.method).toBe('POST')
        expect(init?.body?.toString()).toBe(`attemptId=${attemptId}`)
        return Promise.resolve(completeSaml())
      }
      return fetchApi(input, init)
    })
    testRouter(`${proof}&saml=1`)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: sendEmail }))
    await user.type(
      await screen.findByLabelText('Email verification link'),
      new URL(emailedLink, location.origin).href,
    )
    await user.click(screen.getByRole('button', { name: verify }))
    const continueButton = await screen.findByRole('button', { name: 'Continue' })
    expect(completeSaml).not.toHaveBeenCalled()
    await user.click(continueButton)
    await waitFor(() => expect(replaceWith).toHaveBeenCalledWith(PATHS.settings))
    expect(completeSaml).toHaveBeenCalledOnce()
    expect(api.to(complete)).toEqual([])
  })

  it.each([403, 503])(
    'keeps controls inert while loading and when discovery returns %s',
    async (status) => {
      const pending = later()
      const api = fakeApi({ 'GET /api/v1/instance': () => pending.response })
      testRouter(emailedLink)
      await screen.findByRole('heading', { name: 'Verify your email' })
      expect(within(screen.getByRole('main')).getByRole('status').textContent).toBe('Loading…')
      expect(screen.queryByRole('button', { name: verify })).toBeNull()
      await pending.answer(json(status, { error: 'private_detail' }))
      await screen.findByText(unavailable)
      expect(screen.queryByRole('button', { name: verify })).toBeNull()
      expect(api.calls.map(({ path }) => path)).toEqual(['/api/v1/instance'])
    },
  )

  it('removes the link fragment and only proves possession after an explicit click', async () => {
    const api = fakeApi({
      'GET /api/v1/instance': () => instance(),
      [consume]: () => json(200, { status: 'proven' }),
    })
    testRouter(emailedLink)
    const confirm = await screen.findByRole('button', { name: verify })
    expect(screen.getByLabelText('Fragment state').textContent).toBe('Cleared')
    expect(api.to(consume)).toEqual([])
    await userEvent.click(confirm)
    await screen.findByText(verified)
    expect(api.to(consume).map(({ body }) => body)).toEqual([{ attemptId, token }])
    expect(api.to(complete)).toEqual([])
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(
      screen.getByText('Return to the tab where you requested verification to continue.'),
    ).toBeDefined()
  })

  it('allows SCIM mailbox confirmation with both SSO protocols off', async () => {
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        close() {}
        postMessage() {}
      },
    )
    const api = fakeApi({
      'GET /api/v1/instance': () =>
        json(200, {
          ssoOidcEnabled: false,
          ssoSamlEnabled: false,
          scimResourcesEnabled: true,
        }),
      [consume]: () => json(200, { status: 'proven' }),
    })
    const startPage = within(renderApp(proof).container)
    await startPage.findByText(unavailable)
    const confirmationPage = within(renderApp(emailedLink).container)
    await userEvent.click(await confirmationPage.findByRole('button', { name: verify }))
    await confirmationPage.findByText(verified)
    expect(api.to(consume).map(({ body }) => body)).toEqual([{ attemptId, token }])
    expect(api.to(send)).toEqual([])
    expect(api.to(complete)).toEqual([])
  })

  it('reads and clears a fresh verification link opened on the same page', async () => {
    const api = fakeApi({ 'GET /api/v1/instance': () => instance() })
    testRouter(PATHS.mailboxProof)
    await screen.findByText(linkError)
    await userEvent.click(screen.getByRole('link', { name: 'Open verification link' }))
    await screen.findByRole('button', { name: verify })
    expect(screen.getByLabelText('Fragment state').textContent).toBe('Cleared')
    expect(api.to(consume)).toEqual([])
  })

  it.each([
    ['/app/bookings?tab=upcoming#recent', '/app/bookings?tab=upcoming#recent'],
    ['/app/bookings?tab=past', '/app/bookings?tab=past'],
  ])('completes to %s only from the originating tab', async (serverPath, destination) => {
    const requested = '/app/bookings?tab=upcoming#recent'
    const subscribers = new Map<string, Set<ProofChannel>>()
    class ProofChannel {
      readonly name: string
      onmessage?: (event: { data: unknown }) => void

      constructor(name: string) {
        this.name = name
        const listeners = subscribers.get(name) ?? new Set<ProofChannel>()
        listeners.add(this)
        subscribers.set(name, listeners)
      }

      postMessage(data: unknown) {
        for (const peer of subscribers.get(this.name) ?? [])
          if (peer !== this) peer.onmessage?.({ data })
      }

      close() {
        subscribers.get(this.name)?.delete(this)
      }
    }
    vi.stubGlobal('BroadcastChannel', ProofChannel)
    const api = fakeApi({
      ...signedOut,
      'GET /api/v1/instance': () => instance(),
      [start]: () => json(200, { redirect: true, url: authorization }),
      [send]: () => json(202, { status: 'queued' }),
      [consume]: () => json(200, { status: 'proven' }),
      [complete]: () => redirectedTo(serverPath),
    })
    const user = userEvent.setup()
    const login = renderApp(
      `${PATHS.signIn}?sso=${providerId}&next=${encodeURIComponent(requested)}`,
    )
    await user.click(await screen.findByRole('button', { name: 'Sign in with single sign-on' }))
    await waitFor(() => expect(goTo).toHaveBeenCalledWith(authorization))
    expect(api.to(start).at(-1)?.body).toEqual({
      providerId,
      intent: 'sign_in',
      returnTo: requested,
    })
    login.unmount()

    const original = within(renderApp(proof).container)
    await user.click(await original.findByRole('button', { name: sendEmail }))
    await original.findByLabelText('Email verification link')
    const email = within(renderApp(emailedLink).container)
    await user.click(await email.findByRole('button', { name: verify }))
    const next = await original.findByRole('button', { name: 'Continue' })
    expect(email.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(original.getByTestId('location').textContent).toBe(PATHS.mailboxProof)
    expect(email.getByTestId('location').textContent).toBe(PATHS.mailboxProof)
    expect(api.to(complete)).toEqual([])
    expect(replaceWith).not.toHaveBeenCalled()

    await user.click(next)
    await waitFor(() => expect(replaceWith).toHaveBeenCalledWith(destination))
    expect(api.to(complete).map(({ body }) => body)).toEqual([{ attemptId }])
  })

  it('keeps the emailed link usable in the original tab when cross-tab messaging is unavailable', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const api = fakeApi({
      'GET /api/v1/instance': () => instance(),
      [send]: () => json(202, { status: 'queued' }),
      [consume]: () => json(200, { status: 'proven' }),
    })
    const user = userEvent.setup()
    const original = within(renderApp(proof).container)
    await user.click(await original.findByRole('button', { name: sendEmail }))
    const input = await original.findByLabelText('Email verification link')

    const email = within(renderApp(emailedLink).container)
    await email.findByText(
      'Copy the link from your email and paste it into the tab where you requested verification.',
    )
    expect(email.queryByRole('button', { name: verify })).toBeNull()
    expect(api.to(consume)).toEqual([])

    await user.click(input)
    await user.paste(new URL(emailedLink, window.location.origin).href)
    await user.click(original.getByRole('button', { name: verify }))
    await original.findByText(verified)
    expect(api.to(consume).map(({ body }) => body)).toEqual([{ attemptId, token }])
    expect(api.to(complete)).toEqual([])
  })

  it.each([
    ['existing account', () => json(200, { status: 'link_required' })],
    ['same-email collision', () => json(409, { error: 'sso_email_collision' })],
    ['stale intent', () => json(400, { error: 'sso_oidc_completion_invalid' })],
    ['authorization denied', () => json(403, { error: 'team_management_access_denied' })],
  ] as const)('uses the same generic completion outcome for %s', async (_scenario, finish) => {
    const api = fakeApi({
      'GET /api/v1/instance': () => instance(),
      [send]: () => json(202, { status: 'queued' }),
      [consume]: () => json(200, { status: 'proven' }),
      [complete]: finish,
    })
    const user = userEvent.setup()
    testRouter(proof)
    await user.click(await screen.findByRole('button', { name: sendEmail }))
    expect(api.to(send).map(({ body }) => body)).toEqual([{ attemptId }])
    const field = await screen.findByLabelText<HTMLInputElement>('Email verification link')
    expect(field.type).toBe('password')
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()

    await user.paste(new URL(emailedLink, window.location.origin).href)
    await user.click(screen.getByRole('button', { name: verify }))
    const next = await screen.findByRole('button', { name: 'Continue' })
    expect(api.to(complete)).toEqual([])
    await user.click(next)
    expect((await screen.findByText(genericOutcome)).textContent).toBe(genericOutcome)
    expect(api.to(complete).map(({ body }) => body)).toEqual([{ attemptId }])
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      '/sign-in?next=%2Fapp%2Fsettings',
    )
  })

  it('never consumes a pasted link for another attempt', async () => {
    const api = fakeApi({
      'GET /api/v1/instance': () => instance(),
      [send]: () => json(202, { status: 'queued' }),
    })
    const user = userEvent.setup()
    renderApp(proof)
    await user.click(await screen.findByRole('button', { name: sendEmail }))
    await screen.findByLabelText('Email verification link')
    await user.paste(
      new URL(emailedLink.replace(attemptId, providerId), window.location.origin).href,
    )
    await user.click(screen.getByRole('button', { name: verify }))
    expect((await screen.findByRole('alert')).textContent).toBe(linkError)
    expect(api.to(consume)).toEqual([])
    expect(api.to(complete)).toEqual([])
  })

  it('preserves a proven attempt after a rate limit and navigates after a successful retry', async () => {
    const destination = '/app/bookings?tab=upcoming'
    const finish = vi
      .fn<() => Response>()
      .mockReturnValueOnce(
        new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'Retry-After': '1' },
        }),
      )
      .mockReturnValueOnce(redirectedTo(destination))
    const api = fakeApi({
      'GET /api/v1/instance': () => instance(),
      [send]: () => json(202, { status: 'queued' }),
      [consume]: () => json(200, { status: 'proven' }),
      [complete]: finish,
    })
    const user = userEvent.setup()
    renderApp(proof)
    await user.click(await screen.findByRole('button', { name: sendEmail }))
    await screen.findByLabelText('Email verification link')
    await user.paste(new URL(emailedLink, window.location.origin).href)
    await user.click(screen.getByRole('button', { name: verify }))
    await user.click(await screen.findByRole('button', { name: 'Continue' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many requests. Wait a minute and try again.',
    )
    expect(screen.getByText(verified)).toBeDefined()
    expect(replaceWith).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(replaceWith).toHaveBeenCalledWith(destination))
    expect(api.to(complete).map(({ body }) => body)).toEqual([{ attemptId }, { attemptId }])
  })
})
