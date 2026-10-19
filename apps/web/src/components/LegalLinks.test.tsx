import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  fakeApi,
  json,
  later,
  ME,
  organizations,
  profile,
  type Routes,
  renderApp,
  signedIn,
  signedOut,
} from '../test/fake-api.tsx'
import { eventRoutes } from '../test/public-fixtures.ts'

const policies = {
  privacyPolicyUrl: 'https://operator.example/privacy',
  termsUrl: 'https://operator.example/terms',
}
const consentInfo = {
  clientName: 'Synthetic connector',
  clientId: 'https://connector.test/client.json',
  redirectUri: 'https://connector.test/callback',
  scopes: ['mcp:tools'],
  organizations: [ME.organization],
  selectedOrganization: ME.organization,
}
const surfaces: { name: string; path: string; routes: Routes; heading: string }[] = [
  { name: 'sign-in', path: '/sign-in', routes: signedOut, heading: 'Sign in to Hourmere' },
  {
    name: 'signed-in settings',
    path: '/app/settings',
    routes: { ...signedIn, ...profile(), ...organizations() },
    heading: 'Settings',
  },
  ...['authorize', 'consent'].map((step) => ({
    name: `MCP ${step}`,
    path: `/oauth/${step}?sig=synthetic#intent=00000000-0000-7000-8000-000000000004`,
    routes: {
      ...signedIn,
      'POST /api/v1/mcp-oauth/request': () => json(200, consentInfo),
    },
    heading: step === 'consent' ? 'Approve connection' : 'Connect an AI app',
  })),
  { name: 'public booking', path: '/ada/intro', routes: eventRoutes(), heading: 'Intro call' },
]

describe('operator policy links', () => {
  it.each(surfaces)(
    'shows configured URLs on $name without sharing page details',
    async (surface) => {
      fakeApi({
        ...surface.routes,
        'GET /api/v1/instance': () =>
          json(200, { ...policies, signIn: { email: true, google: false, microsoft: false } }),
      })
      renderApp(surface.path)
      await screen.findByRole('heading', { name: surface.heading, level: 1 })
      for (const [label, href] of [
        ['Privacy policy', policies.privacyPolicyUrl],
        ['Terms of service', policies.termsUrl],
      ]) {
        const link = await screen.findByRole('link', { name: label })
        expect(link.getAttribute('href')).toBe(href)
        expect(link.getAttribute('target')).toBe('_blank')
        expect(link.getAttribute('rel')).toBe('noopener noreferrer')
      }
    },
  )

  it.each(surfaces)('hides unconfigured links on $name', async (surface) => {
    const api = fakeApi({ ...surface.routes })
    renderApp(surface.path)
    await screen.findByRole('heading', { name: surface.heading, level: 1 })
    await waitFor(() => expect(api.to('GET /api/v1/instance').length).toBeGreaterThan(0))
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(screen.queryByRole('link', { name: 'Privacy policy' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Terms of service' })).toBeNull()
  })

  it.each(['privacyPolicyUrl', 'termsUrl'] as const)(
    'independently shows %s and translates visible labels',
    async (key) => {
      fakeApi({
        ...signedOut,
        'GET /api/v1/instance': () => json(200, { [key]: policies[key], signIn: { email: true } }),
      })
      renderApp('/sign-in')
      const shown = key === 'privacyPolicyUrl' ? 'Privacy policy' : 'Terms of service'
      const hidden = key === 'privacyPolicyUrl' ? 'Terms of service' : 'Privacy policy'
      await screen.findByRole('link', { name: shown })
      expect(screen.queryByRole('link', { name: hidden })).toBeNull()
      await userEvent.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
      expect(
        screen
          .getByRole('link', { name: key === 'privacyPolicyUrl' ? '隐私政策' : '服务条款' })
          .getAttribute('href'),
      ).toBe(policies[key])
    },
  )

  it('keeps the links visible after sending a sign-in email', async () => {
    const api = fakeApi({
      ...signedOut,
      'GET /api/v1/instance': () => json(200, { ...policies, signIn: { email: true } }),
      'POST /api/auth/sign-in/magic-link': () => json(200, { status: true }),
    })
    renderApp('/sign-in')
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await screen.findByRole('link', { name: 'Privacy policy' })
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    await screen.findByRole('heading', { name: 'Check your email' })
    expect(screen.getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe(
      policies.privacyPolicyUrl,
    )
    expect(screen.getByRole('link', { name: 'Terms of service' }).getAttribute('href')).toBe(
      policies.termsUrl,
    )
    expect(api.to('GET /api/v1/instance')).toHaveLength(1)
  })

  it('hides links while discovery is pending and when it fails', async () => {
    const pending = later()
    fakeApi({
      ...signedOut,
      'GET /api/v1/instance': () => pending.response,
    })
    renderApp('/sign-in')
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    expect(screen.queryByRole('link', { name: 'Privacy policy' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Terms of service' })).toBeNull()
    await pending.answer(json(503, { error: 'internal_error' }))
    expect(screen.queryByRole('link', { name: 'Privacy policy' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Terms of service' })).toBeNull()
  })
})
