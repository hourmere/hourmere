import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { PATHS } from '../../paths.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import type { SsoProvider } from './setup.ts'

const organization = {
  id: '00000000-0000-7000-8000-000000000010',
  name: 'Engineering',
  slug: 'engineering',
  personal: false,
}
const domain = {
  id: '00000000-0000-7000-8000-000000000011',
  name: 'login.example.com',
  generation: 2,
  status: 'verified',
}
const provider: SsoProvider = {
  id: '00000000-0000-7000-8000-000000000012',
  protocol: 'oidc',
  revision: 3,
  enabled: false,
  displayName: 'Example identity',
  issuer: 'https://identity.example.com',
  clientId: 'hourmere-web',
  validationStatus: 'unknown',
  testStatus: 'unknown',
  createdAt: '2026-10-01T00:00:00Z',
  domains: [domain],
}
const list = '/api/v1/team/sso/providers'
const detail = `${list}/${provider.id}`
const providerPage = (...data: SsoProvider[]) => json(200, { data, nextCursor: null })
const base: Routes = {
  ...signedInAs({ ...ME, organization }),
  'GET /api/v1/instance': () =>
    json(200, {
      ssoOidcEnabled: true,
      ssoSamlEnabled: false,
      signIn: { email: true, google: false, microsoft: false },
    }),
}

describe('SSO provider setup', () => {
  it('creates an OIDC draft with team-owned domains and retires the displayed revision after confirmation', async () => {
    const created = {
      ...provider,
      id: '00000000-0000-7000-8000-000000000013',
      revision: 1,
      displayName: 'New provider',
    }
    let showCreated = false
    const requests = fakeApi({
      ...base,
      [`GET ${list}`]: () =>
        showCreated ? providerPage(provider, created) : providerPage(provider),
      [`POST ${list}`]: () => {
        showCreated = true
        return json(201, { provider: created })
      },
      [`DELETE ${list}/${created.id}`]: () => {
        showCreated = false
        return json(200, { deleted: true })
      },
    })
    const user = userEvent.setup()
    renderApp(PATHS.sso)
    // Wait for the signed-in frame and the lazy setup route on the initial visit.
    const add = await screen.findByRole('button', { name: 'Add provider' }, { timeout: 3000 })
    await user.click(add)
    const form = within(screen.getByRole('form', { name: 'Add OIDC provider' }))
    await user.type(form.getByLabelText('Display name'), created.displayName)
    await user.type(form.getByLabelText('Issuer URL'), created.issuer)
    await user.type(form.getByLabelText('Client ID'), 'new-client')
    await user.type(form.getByLabelText('Client secret'), 'synthetic-create-secret')
    await user.type(
      form.getByLabelText(/Authorization endpoint/),
      'https://identity.example.com/authorize',
    )
    await user.click(form.getByRole('checkbox', { name: domain.name }))
    await user.click(form.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('heading', { name: created.displayName })

    const [posted] = requests.to(`POST ${list}`)
    expect(posted?.headers.get('X-Expected-Organization-Id')).toBe(organization.id)
    expect(posted?.headers.get('Authorization')).toBeNull()
    expect(posted?.body).toEqual({
      displayName: created.displayName,
      domainIds: [domain.id],
      protocol: 'oidc',
      oidc: {
        authorizationEndpoint: 'https://identity.example.com/authorize',
        issuer: created.issuer,
        clientId: 'new-client',
        clientSecret: 'synthetic-create-secret',
      },
    })

    await user.click(
      await screen.findByRole('button', { name: `Retire provider ${created.displayName}` }),
    )
    expect(requests.to(`DELETE ${list}/${created.id}`)).toHaveLength(0)
    const confirmation = screen.getByRole('group', {
      name: 'Retire this provider? This action is permanent.',
    })
    expect(document.activeElement).toBe(
      within(confirmation).getByRole('button', { name: 'Cancel' }),
    )
    await user.click(within(confirmation).getByRole('button', { name: 'Retire provider' }))
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: created.displayName })).toBeNull(),
    )
    const [removed] = requests.to(`DELETE ${list}/${created.id}`)
    expect(removed?.headers.get('X-Expected-Organization-Id')).toBe(organization.id)
    expect(removed?.body).toEqual({ expectedRevision: created.revision })
  })

  it('preserves the secret on an ordinary edit and uses a blank, write-only replacement control', async () => {
    const stored = 'synthetic-stored-secret'
    let latest = { ...provider, clientSecret: stored }
    const replacement = later()
    const requests = fakeApi({
      ...base,
      [`GET ${list}`]: () => providerPage(latest),
      [`PATCH ${detail}`]: ({ body }) => {
        const patch = body as { displayName: string; oidc?: { clientSecret: string } }
        latest = { ...latest, displayName: patch.displayName, revision: latest.revision + 1 }
        return patch.oidc ? replacement.response : json(200, { provider: latest })
      },
    })
    const user = userEvent.setup()
    renderApp(PATHS.sso)
    await user.click(await screen.findByRole('button', { name: `Edit ${provider.displayName}` }))
    let form = within(screen.getByRole('form', { name: 'Edit provider' }))
    expect(form.getByLabelText<HTMLInputElement>('Issuer URL').readOnly).toBe(true)
    expect(form.getByLabelText<HTMLInputElement>('Client ID').readOnly).toBe(true)
    expect(form.queryByLabelText('Client secret')).toBeNull()
    const displayName = form.getByLabelText('Display name')
    await user.clear(displayName)
    await user.type(displayName, 'Renamed identity')
    await user.click(form.getByRole('button', { name: 'Save changes' }))
    const renamedButton = await screen.findByRole('button', { name: 'Edit Renamed identity' })
    const [renamed] = requests.to(`PATCH ${detail}`)
    expect(renamed?.body).toEqual({ expectedRevision: 3, displayName: 'Renamed identity' })

    await user.click(renamedButton)
    form = within(screen.getByRole('form', { name: 'Edit provider' }))
    await user.click(form.getByRole('button', { name: 'Replace client secret' }))
    const input = form.getByLabelText<HTMLInputElement>('New client secret')
    expect(input.value).toBe('')
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('new-password')
    expect(screen.queryByDisplayValue(stored)).toBeNull()
    expect(document.body.textContent).not.toContain(stored)
    await user.type(input, 'discarded-replacement')
    await user.click(form.getByRole('button', { name: 'Keep current secret' }))
    await user.click(form.getByRole('button', { name: 'Replace client secret' }))
    const newInput = form.getByLabelText<HTMLInputElement>('New client secret')
    expect(newInput.value).toBe('')
    await user.type(newInput, 'synthetic-replacement')
    await user.click(form.getByRole('button', { name: 'Save changes' }))
    expect(newInput.value).toBe('')
    await waitFor(() => expect(requests.to(`PATCH ${detail}`)).toHaveLength(2))
    const [, replaced] = requests.to(`PATCH ${detail}`)
    expect(replaced?.headers.get('X-Expected-Organization-Id')).toBe(organization.id)
    expect(replaced?.body).toEqual({
      expectedRevision: 4,
      displayName: 'Renamed identity',
      oidc: { clientSecret: 'synthetic-replacement' },
    })
    await replacement.answer(json(200, { provider: latest }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit provider' })).toBeNull())
    expect(document.body.textContent).not.toContain('synthetic-replacement')
  })

  it('discards the stale form only after explicitly reloading the latest revision', async () => {
    const conflict = 'These SSO settings changed. Reload before trying again.'
    let latest = provider
    const requests = fakeApi({
      ...base,
      [`GET ${list}`]: () => providerPage(latest),
      [`PATCH ${detail}`]: () => {
        if (latest === provider) {
          latest = { ...provider, revision: 8, displayName: 'Updated elsewhere' }
          return json(409, { error: 'sso_configuration_changed' })
        }
        latest = { ...latest, revision: 9 }
        return json(200, { provider: latest })
      },
    })
    const user = userEvent.setup()
    renderApp(PATHS.sso)
    await user.click(await screen.findByRole('button', { name: `Edit ${provider.displayName}` }))
    const form = within(screen.getByRole('form', { name: 'Edit provider' }))
    await user.click(form.getByRole('button', { name: 'Replace client secret' }))
    await user.type(form.getByLabelText('New client secret'), 'synthetic-stale-secret')
    await user.click(form.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText(conflict)).toBeTruthy()
    expect(screen.queryByDisplayValue('synthetic-stale-secret')).toBeNull()
    expect(requests.to(`GET ${list}`)).toHaveLength(1)
    expect(requests.to(`PATCH ${detail}`)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Reload settings' }))
    await user.click(await screen.findByRole('button', { name: 'Edit Updated elsewhere' }))
    const freshForm = within(screen.getByRole('form', { name: 'Edit provider' }))
    expect(freshForm.queryByLabelText('New client secret')).toBeNull()
    await user.click(freshForm.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(requests.to(`PATCH ${detail}`)).toHaveLength(2))
    expect(requests.to(`PATCH ${detail}`).map(({ body }) => body)).toEqual([
      {
        expectedRevision: 3,
        displayName: provider.displayName,
        oidc: { clientSecret: 'synthetic-stale-secret' },
      },
      { expectedRevision: 8, displayName: 'Updated elsewhere' },
    ])
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit provider' })).toBeNull())
  })

  it('reloads the inventory when another administrator has retired the provider', async () => {
    let retired = false
    const requests = fakeApi({
      ...base,
      [`GET ${list}`]: () => (retired ? providerPage() : providerPage(provider)),
      [`PATCH ${detail}`]: () => {
        retired = true
        return json(404, { error: 'sso_not_found' })
      },
    })
    const user = userEvent.setup()
    renderApp(PATHS.sso)
    await user.click(await screen.findByRole('button', { name: `Edit ${provider.displayName}` }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await user.click(await screen.findByRole('button', { name: 'Reload settings' }))
    await screen.findByText('No identity providers yet.')
    expect(requests.to(`PATCH ${detail}`)).toHaveLength(1)
  })

  it.each([
    ['team_management_access_denied', 'SSO settings are unavailable in this team.', false],
    ['sso_reauthentication_required', 'Confirm your identity before changing SSO settings.', true],
  ] as const)(
    'handles %s without exposing server details or retaining the entered secret',
    async (code, message, canEdit) => {
      const secret = 'synthetic-denied-secret'
      const raw = 'synthetic server details'
      const requests = fakeApi({
        ...base,
        [`GET ${list}`]: () => providerPage(provider),
        [`PATCH ${detail}`]: () => json(403, { error: code, message: `${raw}: ${secret}` }),
      })
      const user = userEvent.setup()
      renderApp(PATHS.sso)
      await user.click(await screen.findByRole('button', { name: `Edit ${provider.displayName}` }))
      const form = within(screen.getByRole('form', { name: 'Edit provider' }))
      await user.click(form.getByRole('button', { name: 'Replace client secret' }))
      await user.type(form.getByLabelText('New client secret'), secret)
      await user.click(form.getByRole('button', { name: 'Save changes' }))

      expect(await screen.findByText(message)).toBeTruthy()
      expect(document.body.textContent).not.toContain(raw)
      expect(document.body.textContent).not.toContain(secret)
      expect(screen.queryByDisplayValue(secret)).toBeNull()
      expect(Boolean(screen.queryByRole('form', { name: 'Edit provider' }))).toBe(canEdit)
      expect(requests.to(`PATCH ${detail}`)).toHaveLength(1)
    },
  )
})
