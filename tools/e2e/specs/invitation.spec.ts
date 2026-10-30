import type { Page, Request } from '@playwright/test'
import { expect, test } from '../invitation-fixtures.ts'

const guidance =
  'Sign in with the email address that received this invitation. Signing in does not join the team.'

function samePath(page: Page, origin: string, path: string) {
  const target = new URL(page.url())
  return target.origin === origin && `${target.pathname}${target.search}` === path
}

function invitationCalls(page: Page) {
  const calls = { lookups: 0, accepts: 0, publicBookings: 0 }
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path === '/api/auth/organization/get-invitation') calls.lookups++
    if (path === '/api/auth/organization/accept-invitation') calls.accepts++
    if (path.startsWith('/api/v1/public/')) calls.publicBookings++
  })
  return calls
}

function redirectsStayLocal(request: Request, path: string) {
  const body = request.postDataJSON() as { callbackURL?: string; errorCallbackURL?: string }
  expect(body.callbackURL === path, 'The success callback preserves the invitation page').toBe(true)
  const failure = new URL(body.errorCallbackURL ?? '', 'https://fixture.invalid')
  expect(failure.origin === 'https://fixture.invalid' && failure.pathname === '/sign-in').toBe(true)
  expect(
    failure.searchParams.get('next') === path,
    'The failure callback preserves the invitation page',
  ).toBe(true)
}

test('the protected invitation route preserves its ID without revealing invitation details', async ({
  page,
  invitationApp: app,
}) => {
  const calls = invitationCalls(page)
  await page.goto(`${app.url}${app.path}`)
  await expect(
    page.getByRole('heading', { name: 'Sign in to Hourmere', exact: true }),
  ).toBeVisible()
  await expect(page.getByText(guidance, { exact: false })).toBeVisible()
  const target = new URL(page.url())
  expect(target.pathname === '/sign-in' && target.searchParams.get('next') === app.path).toBe(true)
  expect(await page.locator('body').textContent()).not.toContain(app.email)
  expect(await page.locator('body').textContent()).not.toContain('Invitation team')
  expect(calls).toEqual({ lookups: 0, accepts: 0, publicBookings: 0 })
  expect(await app.state()).toEqual({ status: 'pending', joined: false, activeTeam: false })
})

test('an emailed sign-in link returns to the invitation and joining requires the accept button', async ({
  page,
  invitationApp: app,
}) => {
  const calls = invitationCalls(page)
  await page.goto(`${app.url}${app.path}`)
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(app.email)
  const request = page.waitForRequest((request) =>
    request.url().endsWith('/api/auth/sign-in/magic-link'),
  )
  await page.getByRole('button', { name: 'Email me a sign-in link', exact: true }).click()
  redirectsStayLocal(await request, app.path)
  await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible()
  await expect.poll(() => Boolean(app.mailLink())).toBe(true)
  const link = app.mailLink()
  if (!link) throw new Error('The synthetic mailer did not receive the sign-in link')
  await page.goto(link)
  await page.getByRole('button', { name: 'Sign in to Hourmere', exact: true }).click()
  await expect.poll(() => samePath(page, app.url, app.path)).toBe(true)
  await expect(
    page.getByRole('heading', { name: 'Invitation to join Invitation team', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Signed in as', { exact: false })).toContainText(app.email)
  await expect(page.getByText('Invited email', { exact: false })).toContainText(app.email)
  expect(await app.state()).toEqual({ status: 'pending', joined: false, activeTeam: false })
  expect(calls.accepts).toBe(0)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Join team', exact: true })).toBeEnabled()
  expect(await app.state()).toEqual({ status: 'pending', joined: false, activeTeam: false })
  expect(calls.accepts).toBe(0)
  await page.getByRole('button', { name: 'Join team', exact: true }).click()
  await expect.poll(() => samePath(page, app.url, '/app/event-types')).toBe(true)
  await expect
    .poll(() => app.state())
    .toEqual({ status: 'accepted', joined: true, activeTeam: true })
  expect(calls.accepts).toBe(1)
  expect(calls.publicBookings).toBe(0)
  const invitationId = new URL(app.path, app.url).searchParams.get('invitationId')
  const repeated = await page.request.post(`${app.url}/api/auth/organization/accept-invitation`, {
    headers: { origin: app.url },
    data: { invitationId },
  })
  expect(repeated.status()).toBe(400)
  expect((await repeated.json()).code === 'INVITATION_NOT_FOUND').toBe(true)
  expect(await app.membershipCount()).toBe(1)
})

test('an invalid emailed link returns to sign-in with the original invitation page', async ({
  page,
  invitationApp: app,
}) => {
  await page.goto(`${app.url}${app.path}`)
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(app.email)
  await page.getByRole('button', { name: 'Email me a sign-in link', exact: true }).click()
  await expect.poll(() => Boolean(app.mailLink())).toBe(true)
  const link = new URL(app.mailLink() as string)
  const fragment = new URLSearchParams(link.hash.slice(1))
  fragment.set('token', 'synthetic-invalid-token')
  link.hash = fragment.toString()
  await page.goto(link.href)
  await page.getByRole('button', { name: 'Sign in to Hourmere', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('invalid, has expired or was already used')
  const returned = new URL(page.url())
  expect(returned.pathname === '/sign-in' && returned.searchParams.get('next') === app.path).toBe(
    true,
  )
  await expect(page.getByText(guidance, { exact: false })).toBeVisible()
  expect(await app.state()).toEqual({ status: 'pending', joined: false, activeTeam: false })
})

for (const provider of ['Google', 'Microsoft'] as const) {
  test(`${provider} sign-in returns to the invitation without joining automatically`, async ({
    page,
    invitationApp: app,
  }) => {
    const calls = invitationCalls(page)
    await page.goto(`${app.url}${app.path}`)
    const request = page.waitForRequest((request) =>
      request.url().endsWith('/api/auth/sign-in/social'),
    )
    await page
      .getByRole('button', {
        name: provider === 'Google' ? 'Continue with Google' : 'Sign in with Microsoft',
        exact: true,
      })
      .click()
    redirectsStayLocal(await request, app.path)
    await expect.poll(() => samePath(page, app.url, app.path)).toBe(true)
    await expect(
      page.getByRole('heading', { name: 'Invitation to join Invitation team', exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Join team', exact: true })).toBeEnabled()
    expect(await app.state()).toEqual({ status: 'pending', joined: false, activeTeam: false })
    expect(calls.accepts).toBe(0)
    expect(calls.publicBookings).toBe(0)
  })
}

test('off-site next and auth callback values cannot leave the application', async ({
  page,
  invitationApp: app,
}) => {
  for (const next of [
    'https://foreign.invalid/app',
    '//foreign.invalid/app',
    '/\\foreign.invalid/app',
    '/app/../../foreign',
    '/app%2fjoin',
  ]) {
    await page.goto(`${app.url}/sign-in?${new URLSearchParams({ next })}`)
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(app.email)
    const request = page.waitForRequest((request) =>
      request.url().endsWith('/api/auth/sign-in/magic-link'),
    )
    await page.getByRole('button', { name: 'Email me a sign-in link', exact: true }).click()
    const body = (await request).postDataJSON() as { callbackURL: string; errorCallbackURL: string }
    expect(body.callbackURL === '/app' && body.errorCallbackURL === '/sign-in').toBe(true)
    await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible()
  }
  for (const path of ['/api/auth/sign-in/magic-link', '/api/auth/sign-in/social']) {
    for (const field of ['callbackURL', 'errorCallbackURL', 'newUserCallbackURL']) {
      const response = await page.request.post(`${app.url}${path}`, {
        headers: { origin: app.url },
        data: {
          ...(path.endsWith('social') ? { provider: 'google' } : { email: app.email }),
          callbackURL: app.path,
          errorCallbackURL: `/sign-in?${new URLSearchParams({ next: app.path })}`,
          [field]: 'https://foreign.invalid/app',
        },
        maxRedirects: 0,
      })
      expect(response.status()).toBe(403)
      expect(response.headers().location).toBeUndefined()
    }
  }
  expect(await app.state()).toEqual({ status: 'pending', joined: false, activeTeam: false })
})

test('a different account can change accounts without accepting or exposing the invited address', async ({
  page,
  invitationApp: app,
}) => {
  const calls = invitationCalls(page)
  await app.signIn('other')
  await page.goto(`${app.url}${app.path}`)
  await expect(page.getByRole('alert')).toContainText('Use the exact email address')
  expect(await page.locator('body').textContent()).not.toContain(app.email)
  await expect(page.getByRole('button', { name: 'Join team', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Change account', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Sign in to Hourmere', exact: true }),
  ).toBeVisible()
  const target = new URL(page.url())
  expect(target.pathname === '/sign-in' && target.searchParams.get('next') === app.path).toBe(true)
  expect(await app.state()).toEqual({ status: 'pending', joined: false, activeTeam: false })
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(app.email)
  await page.getByRole('button', { name: 'Email me a sign-in link', exact: true }).click()
  await expect.poll(() => Boolean(app.mailLink())).toBe(true)
  const link = app.mailLink()
  if (!link) throw new Error('The synthetic mailer did not receive the replacement sign-in link')
  await page.goto(link)
  await page.getByRole('button', { name: 'Sign in to Hourmere', exact: true }).click()
  await expect.poll(() => samePath(page, app.url, app.path)).toBe(true)
  await expect(page.getByRole('button', { name: 'Join team', exact: true })).toBeEnabled()
  expect(await app.state()).toEqual({ status: 'pending', joined: false, activeTeam: false })
  expect(calls.accepts).toBe(0)
})

for (const state of ['expired', 'canceled', 'invalid'] as const) {
  test(`${state} invitations offer a recoverable result without a sign-in loop`, async ({
    page,
    invitationApp: app,
  }) => {
    const calls = invitationCalls(page)
    await app.signIn()
    if (state === 'expired') await app.expire()
    if (state === 'canceled') await app.cancel()
    const path = state === 'invalid' ? '/app/join?invitationId=invalid' : app.path
    await page.goto(`${app.url}${path}`)
    await expect(page.getByRole('alert')).toContainText('This invitation is unavailable.')
    await expect(page.getByRole('button', { name: 'Join team', exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Go to Hourmere', exact: true })).toBeVisible()
    expect(samePath(page, app.url, path)).toBe(true)
    expect(await app.state()).toEqual({
      status: state === 'canceled' ? 'canceled' : 'pending',
      joined: false,
      activeTeam: false,
    })
    expect(calls.accepts).toBe(0)
    if (state !== 'invalid') {
      await page.getByRole('button', { name: 'Check invitation status', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('This invitation is unavailable.')
      expect(samePath(page, app.url, path)).toBe(true)
    }
  })
}

test('an existing member goes directly to the team without accepting the invitation', async ({
  page,
  invitationApp: app,
}) => {
  const calls = invitationCalls(page)
  await app.signIn()
  await app.addMember()
  await page.goto(`${app.url}${app.path}`)
  await expect(
    page.getByText('You are already a member of Invitation team.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Join team', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Go to team', exact: true }).click()
  await expect.poll(() => samePath(page, app.url, '/app/event-types')).toBe(true)
  expect(await app.state()).toEqual({ status: 'pending', joined: true, activeTeam: true })
  expect(await app.membershipCount()).toBe(1)
  expect(calls.accepts).toBe(0)
})

for (const initial of [true, false]) {
  test(`${initial ? 'an initially unverified account' : 'email proof revoked after page authentication'} cannot join and the server still refuses a direct accept`, async ({
    page,
    invitationApp: app,
  }) => {
    const calls = invitationCalls(page)
    await app.signIn(initial ? 'unverified' : 'recipient')
    if (!initial) {
      await page.route('**/api/auth/get-session', async (route) => {
        await app.unverify()
        await route.continue()
      })
    }
    await page.goto(`${app.url}${app.path}`)
    await expect(page.getByRole('alert')).toContainText(
      'Confirm your email address by signing in with an email link',
    )
    await expect(page.getByRole('button', { name: 'Join team', exact: true })).toHaveCount(0)
    const invitationId = new URL(app.path, app.url).searchParams.get('invitationId')
    // This direct request omits every client eligibility check, as a mutated client would.
    const response = await page.request.post(`${app.url}/api/auth/organization/accept-invitation`, {
      headers: { origin: app.url },
      data: { invitationId },
    })
    expect(response.status()).toBe(403)
    expect(
      (await response.json()).code ===
        'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION',
    ).toBe(true)
    expect(await app.state()).toEqual({ status: 'pending', joined: false, activeTeam: false })
    expect(calls.lookups).toBe(0)
    expect(calls.accepts).toBe(0)
  })
}

test('closed signup gives an invitation recipient an owner recovery step without a sign-in loop', async ({
  page,
  invitationApp: app,
}) => {
  await app.restrictSignup()
  await page.goto(`${app.url}${app.path}`)
  await expect(
    page.getByText('If you cannot sign in with the invited email', { exact: false }),
  ).toBeVisible()
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(app.email)
  await page.getByRole('button', { name: 'Email me a sign-in link', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible()
  await expect(
    page.getByText('If you cannot sign in with the invited email', { exact: false }),
  ).toBeVisible()
  expect(Boolean(app.mailLink())).toBe(false)
  const target = new URL(page.url())
  expect(target.pathname === '/sign-in' && target.searchParams.get('next') === app.path).toBe(true)
  expect(await app.state()).toEqual({ status: 'pending', joined: false, activeTeam: false })
})
