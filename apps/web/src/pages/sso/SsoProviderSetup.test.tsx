import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { AppShell, RequireSession, SessionLayout, SsoSetupPage } from '../../lazy-pages.tsx'
import { PATHS } from '../../paths.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { resolveLazy } from '../../test/resolve-lazy.ts'
import type { SsoProvider } from './setup.ts'

beforeAll(() => resolveLazy(SessionLayout, RequireSession, AppShell, SsoSetupPage))

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
const samlProvider: SsoProvider = {
  ...provider,
  id: '00000000-0000-7000-8000-000000000020',
  protocol: 'saml',
  displayName: 'SAML identity',
  issuer: 'urn:example:saml:idp',
  clientId: null,
}
const samlDetail = `${list}/${samlProvider.id}`
const providerPage = (...data: SsoProvider[]) => json(200, { data, nextCursor: null })
const base: Routes = {
  ...signedInAs({ ...ME, organization }),
  'GET /api/v1/team/sso/policy': () =>
    json(200, {
      admission: 'invitation_only',
      policyRevision: 1,
      requireSso: false,
      trustGeneration: 1,
    } satisfies Schemas['SsoPolicy']),
  'GET /api/v1/instance': () =>
    json(200, {
      ssoOidcEnabled: true,
      ssoSamlEnabled: false,
      signIn: { email: true, google: false, microsoft: false },
    }),
}
const samlBase: Routes = {
  ...base,
  'GET /api/v1/instance': () => json(200, { ssoOidcEnabled: false, ssoSamlEnabled: true }),
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
    const add = await screen.findByRole('button', { name: 'Add provider' })
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
    const cancel = within(confirmation).getByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(document.activeElement).toBe(cancel))
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
    'handles %s without exposing server details or keeping the secret in the form',
    async (code, message, canEdit) => {
      const secret = 'synthetic-denied-secret'
      const raw = 'synthetic server details'
      const requests = fakeApi({
        ...base,
        [`GET ${list}`]: () => providerPage(provider),
        [`PATCH ${detail}`]: () =>
          json(403, {
            error: code,
            message: `${raw}: ${secret}`,
            ...(code === 'sso_reauthentication_required' && {
              attemptId: '00000000-0000-7000-8000-000000000015',
              proofMethods: ['mailbox'],
              expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            }),
          }),
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

describe('SAML provider setup', () => {
  it('retains saved SAML providers for trust reduction while OIDC setup stays available', async () => {
    const otherLink = { id: '00000000-0000-7000-8000-000000000023', generation: 3 }
    const deleteLink = `DELETE ${samlDetail}/links/${otherLink.id}`
    const requests = fakeApi({
      ...base,
      'GET /api/v1/me': () =>
        json(200, {
          ...ME,
          organization,
          sso: {
            requireSso: false,
            providers: [],
            links: [],
            attempts: [],
            proofs: [],
          },
        }),
      [`GET ${list}`]: () =>
        providerPage(provider, { ...samlProvider, enabled: true, links: [otherLink] }),
      [deleteLink]: () => new Response(null, { status: 204 }),
    })
    const user = userEvent.setup()
    renderApp(PATHS.sso)

    const add = await screen.findByRole('button', { name: 'Add provider' })
    expect(screen.queryByRole('button', { name: 'Add SAML provider' })).toBeNull()
    const saved = within(screen.getByRole('region', { name: samlProvider.displayName }))
    for (const action of ['Edit', 'Test provider', 'Enable provider']) {
      expect(
        saved.queryByRole('button', { name: `${action} ${samlProvider.displayName}` }),
      ).toBeNull()
    }
    expect(saved.queryByRole('link', { name: 'Download service provider metadata' })).toBeNull()
    expect(
      saved.getByRole('button', { name: `Disable provider ${samlProvider.displayName}` }),
    ).toBeTruthy()
    expect(
      saved.getByRole('button', { name: `Retire provider ${samlProvider.displayName}` }),
    ).toBeTruthy()
    await user.selectOptions(saved.getByRole('combobox', { name: 'Identity link' }), otherLink.id)
    await user.click(saved.getByRole('button', { name: 'Retire identity link' }))
    const confirmation = within(saved.getByRole('group', { name: 'Retire this identity link?' }))
    await user.click(confirmation.getByRole('button', { name: 'Retire identity link' }))
    await saved.findByText('Identity link retired.')
    expect(requests.to(deleteLink).map(({ body }) => body)).toEqual([
      { expectedLinkGeneration: otherLink.generation },
    ])
    await user.click(add)
    const form = within(screen.getByRole('form', { name: 'Add OIDC provider' }))
    expect(form.getByLabelText('Client secret')).toBeTruthy()
    expect(form.queryByText('Signing certificates')).toBeNull()
    expect(requests.to(`POST ${list}`)).toHaveLength(0)
  })

  it('imports IdP metadata through a write and exposes only the safe summary and SP metadata link', async () => {
    const metadata = '<EntityDescriptor>private-import-input</EntityDescriptor>'
    const metadataUrl = 'https://identity.example.test/private-metadata-path'
    const serverCertificate = 'private-returned-certificate'
    const serverSecret = 'private-returned-secret'
    const unexpectedFields = {
      saml: { metadataDocument: metadata, metadataUrl, signingCertificates: [serverCertificate] },
      oidc: { clientSecret: serverSecret },
    }
    let saved = false
    const requests = fakeApi({
      ...samlBase,
      [`GET ${list}`]: () =>
        saved ? providerPage({ ...samlProvider, ...unexpectedFields }) : providerPage(),
      [`POST ${list}`]: () => {
        saved = true
        return json(201, { provider: { ...samlProvider, ...unexpectedFields } })
      },
    })
    const user = userEvent.setup()
    renderApp(PATHS.sso)
    await user.click(await screen.findByRole('button', { name: 'Add SAML provider' }))
    const form = within(screen.getByRole('form', { name: 'Add SAML provider' }))
    const source = form.getByLabelText('SAML configuration source')
    await user.type(form.getByLabelText('Display name'), samlProvider.displayName)
    expect(form.getByLabelText('Identity provider entity ID')).toBeTruthy()
    expect(form.getByLabelText('HTTP-Redirect sign-in URL')).toBeTruthy()
    expect(form.getByText('Signed assertions are required.')).toBeTruthy()
    await user.selectOptions(source, 'url')
    const url = form.getByLabelText<HTMLInputElement>('Identity provider metadata URL')
    expect(url.hasAttribute('data-private')).toBe(true)
    await user.type(url, metadataUrl)
    await user.selectOptions(source, 'xml')
    await user.selectOptions(source, 'url')
    expect(form.getByLabelText<HTMLInputElement>('Identity provider metadata URL').value).toBe('')
    await user.selectOptions(source, 'xml')
    const xml = form.getByLabelText<HTMLTextAreaElement>('Identity provider metadata XML')
    expect(xml.hasAttribute('data-private')).toBe(true)
    await user.click(xml)
    await user.paste(metadata)
    await user.click(form.getByRole('button', { name: 'Save changes' }))
    expect(xml.value).toBe('')

    const metadataLink = await screen.findByRole('link', {
      name: 'Download service provider metadata',
    })
    expect(metadataLink.getAttribute('href')).toBe(
      `/api/auth/sso/saml2/sp/metadata/${samlProvider.id}`,
    )
    expect(metadataLink.hasAttribute('download')).toBe(true)
    const [posted] = requests.to(`POST ${list}`)
    expect(posted?.headers.get('X-Expected-Organization-Id')).toBe(organization.id)
    expect(posted?.body).toEqual({
      displayName: samlProvider.displayName,
      domainIds: [],
      protocol: 'saml',
      saml: { metadataDocument: metadata, wantAssertionsSigned: true },
    })

    await user.click(screen.getByRole('button', { name: `Edit ${samlProvider.displayName}` }))
    const edit = within(screen.getByRole('form', { name: 'Edit provider' }))
    expect(edit.getByLabelText<HTMLInputElement>('Identity provider entity ID').readOnly).toBe(true)
    expect(edit.queryByLabelText(/Subject attribute/)).toBeNull()
    expect(edit.getByLabelText<HTMLTextAreaElement>('Signing certificate 1').value).toBe('')
    await user.selectOptions(edit.getByLabelText('SAML configuration source'), 'xml')
    expect(edit.getByLabelText<HTMLTextAreaElement>('Identity provider metadata XML').value).toBe(
      '',
    )
    await user.selectOptions(edit.getByLabelText('SAML configuration source'), 'url')
    expect(edit.getByLabelText<HTMLInputElement>('Identity provider metadata URL').value).toBe('')
    for (const value of [metadata, metadataUrl, serverCertificate, serverSecret]) {
      expect(screen.queryByDisplayValue(value)).toBeNull()
      expect(document.body.textContent).not.toContain(value)
    }
  })

  it('submits overlapping signing certificates with the displayed revision and reloads after a conflict', async () => {
    const oldCertificate = '-----BEGIN CERTIFICATE-----\nT0xE\n-----END CERTIFICATE-----'
    const newCertificate = '-----BEGIN CERTIFICATE-----\nTkVX\n-----END CERTIFICATE-----'
    const replacement = later()
    let current = samlProvider
    const requests = fakeApi({
      ...samlBase,
      [`GET ${list}`]: () => providerPage(current),
      [`PATCH ${samlDetail}`]: () => {
        if (current.revision === 3) {
          current = { ...current, revision: 5 }
          return replacement.response
        }
        current = { ...current, revision: current.revision + 1 }
        return json(200, { provider: current })
      },
      [`POST ${samlDetail}/test`]: () =>
        json(200, { url: 'https://identity.example.test/saml?RelayState=synthetic-attempt' }),
    })
    const user = userEvent.setup()
    renderApp(PATHS.sso)
    const edit = `Edit ${samlProvider.displayName}`
    await user.click(await screen.findByRole('button', { name: edit }))
    let form = within(screen.getByRole('form', { name: 'Edit provider' }))
    await user.click(form.getByRole('button', { name: 'Add signing certificate' }))
    const first = form.getByLabelText<HTMLTextAreaElement>('Signing certificate 1')
    const second = form.getByLabelText<HTMLTextAreaElement>('Signing certificate 2')
    for (const [field, certificate] of [
      [first, oldCertificate],
      [second, newCertificate],
    ] as const) {
      expect(field.hasAttribute('data-private')).toBe(true)
      await user.click(field)
      await user.paste(certificate)
    }
    await user.click(form.getByRole('button', { name: 'Save changes' }))
    expect(first.value).toBe('')
    expect(second.value).toBe('')
    await replacement.answer(
      json(409, { error: 'sso_configuration_changed', message: oldCertificate }),
    )
    await screen.findByText('These SSO settings changed. Reload before trying again.')
    expect(document.body.textContent).not.toContain(oldCertificate)
    expect(requests.to(`GET ${list}`)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Reload settings' }))
    await user.click(await screen.findByRole('button', { name: edit }))
    form = within(screen.getByRole('form', { name: 'Edit provider' }))
    expect(form.getByLabelText<HTMLTextAreaElement>('Signing certificate 1').value).toBe('')
    expect(form.queryByLabelText('Signing certificate 2')).toBeNull()
    await user.click(form.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(requests.to(`PATCH ${samlDetail}`)).toHaveLength(2))
    expect(requests.to(`PATCH ${samlDetail}`).map(({ body }) => body)).toEqual([
      {
        expectedRevision: 3,
        displayName: samlProvider.displayName,
        saml: { signingCertificates: [oldCertificate, newCertificate] },
      },
      { expectedRevision: 5, displayName: samlProvider.displayName },
    ])
    await screen.findByText('Revision 6 · Disabled')
    await user.click(
      await screen.findByRole('button', { name: `Test provider ${samlProvider.displayName}` }),
    )
    const testLink = await screen.findByRole('link', { name: 'Continue to identity provider' })
    expect(testLink.hasAttribute('data-private')).toBe(true)
    expect(requests.to(`POST ${samlDetail}/test`)[0]?.body).toEqual({ expectedRevision: 6 })
  })

  it('replaces raw invalid-metadata diagnostics with a localized-safe error and clears the input', async () => {
    const raw = '<EntityDescriptor>private-rejected-input</EntityDescriptor>'
    const requests = fakeApi({
      ...samlBase,
      [`GET ${list}`]: () => providerPage(samlProvider),
      [`PATCH ${samlDetail}`]: () => json(400, { error: 'invalid_request', message: raw }),
    })
    const user = userEvent.setup()
    renderApp(PATHS.sso)
    await user.click(
      await screen.findByRole('button', { name: `Edit ${samlProvider.displayName}` }),
    )
    const form = within(screen.getByRole('form', { name: 'Edit provider' }))
    await user.selectOptions(form.getByLabelText('SAML configuration source'), 'xml')
    const xml = form.getByLabelText<HTMLTextAreaElement>('Identity provider metadata XML')
    await user.click(xml)
    await user.paste(raw)
    await user.click(form.getByRole('button', { name: 'Save changes' }))

    await screen.findByText(
      'Check the SAML metadata, sign-in URL and signing certificates, then try again.',
    )
    expect(xml.value).toBe('')
    expect(document.body.textContent).not.toContain(raw)
    expect(requests.to(`PATCH ${samlDetail}`)[0]?.body).toEqual({
      expectedRevision: samlProvider.revision,
      displayName: samlProvider.displayName,
      saml: { metadataDocument: raw },
    })
  })

  it('keeps activation unavailable with neutral copy when domain verification is unknown', async () => {
    const requests = fakeApi({
      ...samlBase,
      [`GET ${list}`]: () =>
        providerPage({
          ...samlProvider,
          testStatus: 'passed',
          domains: [{ ...domain, status: 'unknown' }],
        }),
    })
    renderApp(PATHS.sso)
    const activate = await screen.findByRole<HTMLButtonElement>('button', {
      name: `Enable provider ${samlProvider.displayName}`,
    })
    expect(activate.disabled).toBe(true)
    expect(screen.getByText(/Verification unknown/)).toBeTruthy()
    expect(screen.queryByText(/Verify an associated domain before enabling/)).toBeNull()
    expect(requests.to(`POST ${samlDetail}/activation`)).toHaveLength(0)
  })

  it('keeps activation unavailable with neutral copy when a test result is unknown', async () => {
    fakeApi({ ...samlBase, [`GET ${list}`]: () => providerPage(samlProvider) })
    renderApp(PATHS.sso)
    await screen.findByText('Provider test status is unavailable.')
    expect(screen.queryByText('No test result for the current revision.')).toBeNull()
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: `Enable provider ${samlProvider.displayName}`,
      }).disabled,
    ).toBe(true)
  })

  it('renders the SAML source and editor controls in Simplified Chinese', async () => {
    fakeApi({
      ...samlBase,
      ...profile({ ...PROFILE, locale: 'zh-CN' }),
      [`GET ${list}`]: () => providerPage(),
    })
    const user = userEvent.setup()
    renderApp(PATHS.sso)
    await user.click(await screen.findByRole('button', { name: '添加 SAML 提供方' }))
    const form = within(screen.getByRole('form', { name: '添加 SAML 提供方' }))
    expect(form.getByLabelText('SAML 配置来源')).toBeTruthy()
    expect(form.queryByLabelText('SAML configuration source')).toBeNull()
  })
})
