import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PATHS } from '../../paths.ts'
import { fakeApi, json, ME, type Routes, renderApp, signedInAs } from '../../test/fake-api.tsx'
import type { SsoDomain, SsoProvider } from './setup.ts'

const team = {
  ...ME.organization,
  id: '00000000-0000-7000-8000-000000000042',
  name: 'Copper North',
  slug: 'copper-north',
  personal: false,
}
const domain: SsoDomain = {
  id: '00000000-0000-7000-8000-000000000043',
  generation: 5,
  name: 'mail.example.test',
  status: 'verified',
}
const provider: SsoProvider = {
  id: '00000000-0000-7000-8000-000000000044',
  displayName: 'Copper North login',
  protocol: 'oidc',
  revision: 1,
  enabled: false,
  issuer: 'https://oidc.example.test',
  clientId: 'example-client',
  createdAt: '2026-10-01T09:00:00.000Z',
  domains: [domain],
  testStatus: 'not_tested',
  validationStatus: 'unknown',
}
const nextDomain = { ...domain, generation: 6, status: 'pending' }
const record = {
  domain: nextDomain,
  txtName: `_hourmere-sso.${domain.name}`,
  txtValue: 'synthetic-txt-fixture',
  expiresAt: '2026-10-02T09:00:00.000Z',
}
const providerList = 'GET /api/v1/team/sso/providers'
const generateChallenge = 'POST /api/v1/team/sso/domains'
const verifyDomain = `POST /api/v1/team/sso/domains/${domain.id}/verify`
const retireDomain = `DELETE /api/v1/team/sso/domains/${domain.id}`

function renderDomains(routes: Routes = {}) {
  const api = fakeApi({
    ...signedInAs({ ...ME, organization: team }),
    'GET /api/v1/instance': () => json(200, { ssoOidcEnabled: true, ssoSamlEnabled: false }),
    [providerList]: () => json(200, { data: [], nextCursor: null }),
    [generateChallenge]: () => json(201, record),
    ...routes,
  })
  renderApp(PATHS.ssoDomains)
  return api
}

async function enterDomain(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByRole('textbox', { name: 'Domain name' }), domain.name)
  await user.click(screen.getByRole('button', { name: 'Generate DNS challenge' }))
  return screen.findByRole('region', { name: 'DNS TXT record' })
}

describe('SSO domain setup', () => {
  it('copies each TXT field on request and never redisplays a dismissed challenge', async () => {
    const user = userEvent.setup()
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText')
    const api = renderDomains()
    const challenge = await enterDomain(user)
    expect(document.activeElement).toBe(within(challenge).getByRole('heading'))
    expect(within(challenge).queryByText(record.txtValue)?.hasAttribute('data-private')).toBe(true)
    expect(clipboard).not.toHaveBeenCalled()
    expect(
      api.to(generateChallenge).map(({ body, headers }) => ({
        body,
        team: headers.get('X-Expected-Organization-Id'),
      })),
    ).toEqual([{ body: { domain: domain.name }, team: team.id }])

    await user.click(within(challenge).getByRole('button', { name: 'Copy TXT name' }))
    await user.click(within(challenge).getByRole('button', { name: 'Copy TXT value' }))
    expect(
      clipboard.mock.calls.map(
        ([value], index) => value === [record.txtName, record.txtValue][index],
      ),
    ).toEqual([true, true])
    await user.click(within(challenge).getByRole('button', { name: 'Dismiss' }))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Domain name' }))

    await user.click(screen.getByRole('link', { name: 'Identity providers' }))
    await user.click(screen.getByRole('link', { name: 'SSO domains' }))
    expect(await screen.findByRole('heading', { name: domain.name })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'DNS TXT record' })).toBeNull()
    expect(screen.queryByText(record.txtValue) === null).toBe(true)
    expect(api.to(generateChallenge)).toHaveLength(1)
  })

  it.each(['tab', 'page snapshot'] as const)(
    'clears a visible challenge on leaving via %s',
    async (how) => {
      const user = userEvent.setup()
      const api = renderDomains()
      await enterDomain(user)
      if (how === 'tab') {
        await user.click(screen.getByRole('link', { name: 'Identity providers' }))
        await user.click(screen.getByRole('link', { name: 'SSO domains' }))
      } else {
        act(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
        act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
      }
      expect(await screen.findByRole('heading', { name: domain.name })).toBeTruthy()
      expect(screen.queryByRole('region', { name: 'DNS TXT record' })).toBeNull()
      expect(screen.queryByText(record.txtValue) === null).toBe(true)
      expect(api.to(generateChallenge)).toHaveLength(1)
    },
  )

  it('rotates explicitly and sends the new generation for verification and retirement', async () => {
    const user = userEvent.setup()
    const api = renderDomains({
      [providerList]: () => json(200, { data: [provider], nextCursor: null }),
      [verifyDomain]: () => json(200, { domain: { ...nextDomain, status: 'unknown' } }),
      [retireDomain]: () => json(200, { deleted: true }),
    })
    const rotate = await screen.findByRole('button', {
      name: `Rotate challenge for ${domain.name}`,
    })
    await user.click(rotate)
    const rotation = screen.getByRole('group', { name: 'Rotate DNS challenge?' })
    expect(document.activeElement).toBe(within(rotation).getByRole('button', { name: 'Cancel' }))
    expect(api.to(generateChallenge)).toHaveLength(0)
    await user.click(within(rotation).getByRole('button', { name: 'Rotate challenge' }))
    await screen.findByRole('region', { name: 'DNS TXT record' })
    expect(screen.getByText('Awaiting DNS verification')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: `Verify domain ${domain.name}` }))
    expect(await screen.findByText('Verification unknown')).toBeTruthy()
    expect(screen.queryByText('Verification failed')).toBeNull()
    expect(screen.queryByText(record.txtValue) === null).toBe(true)

    await user.click(screen.getByRole('button', { name: `Retire domain ${domain.name}` }))
    expect(api.to(retireDomain)).toHaveLength(0)
    const retirement = screen.getByRole('group', { name: 'Retire domain?' })
    await user.click(within(retirement).getByRole('button', { name: 'Retire domain' }))
    expect(await screen.findByText('Domain retired.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: domain.name })).toBeNull()

    for (const operation of [verifyDomain, retireDomain]) {
      expect(
        api.to(operation).map(({ body, headers }) => ({
          body,
          team: headers.get('X-Expected-Organization-Id'),
        })),
      ).toEqual([{ body: { expectedGeneration: nextDomain.generation }, team: team.id }])
    }
  })

  it('asks before rotating when a known domain is entered in Unicode', async () => {
    const user = userEvent.setup()
    const known = { ...domain, name: 'xn--bcher-kva.example.com' }
    const api = renderDomains({
      [providerList]: () =>
        json(200, { data: [{ ...provider, domains: [known] }], nextCursor: null }),
    })
    await user.type(
      await screen.findByRole('textbox', { name: 'Domain name' }),
      'Bücher.example.com.',
    )
    await user.click(screen.getByRole('button', { name: 'Generate DNS challenge' }))
    const confirmation = screen.getByRole('group', { name: 'Rotate DNS challenge?' })
    expect(confirmation.textContent).toContain(known.name)
    expect(api.to(generateChallenge)).toHaveLength(0)
  })

  it('reloads a conflicted domain from the provider inventory before another verification', async () => {
    const user = userEvent.setup()
    let inventory = provider
    let first = true
    const api = renderDomains({
      [providerList]: () => json(200, { data: [inventory], nextCursor: null }),
      [verifyDomain]: () => {
        if (first) {
          first = false
          inventory = { ...provider, domains: [nextDomain] }
          return json(409, { error: 'sso_configuration_changed' })
        }
        return json(200, { domain: { ...nextDomain, status: 'verified' } })
      },
    })
    const verify = { name: `Verify domain ${domain.name}` }
    await user.click(await screen.findByRole('button', verify))
    expect(
      await screen.findByText('These SSO settings changed. Reload before trying again.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', verify)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Reload settings' }))
    await user.click(await screen.findByRole('button', verify))
    expect(await screen.findByText('Verified')).toBeTruthy()
    expect(api.to(verifyDomain).map(({ body }) => body)).toEqual([
      { expectedGeneration: domain.generation },
      { expectedGeneration: nextDomain.generation },
    ])
  })
})
