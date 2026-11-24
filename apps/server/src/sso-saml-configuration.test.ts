import { randomBytes } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { type SsoRequest, SsoTransportError } from '@hourmere/outbound/sso'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  oidcProviderValues,
  samlProviderValues,
  ssoFixture,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import type { SsoCapabilities } from './sso.ts'
import { sealSsoProviderConfiguration } from './sso-configuration.ts'
import { resolveSamlProviderInput } from './sso-saml-configuration.ts'
import { samlSigningIdentity } from './sso-saml-fixtures.ts'
import { samlSignInRoutes } from './sso-saml-sign-in.ts'
import { parseSamlXml, samlMaximumResponseBytes } from './sso-saml-verifier.ts'

const publicUrl = 'https://hourmere.example.test'
const entityId = 'urn:example:synthetic-idp'
const ssoUrl = 'https://login.example.com/saml'
const metadataUrl = 'https://login.example.com/saml/metadata'
const protocolNamespace = 'urn:oasis:names:tc:SAML:2.0:protocol'
const metadataNamespace = 'urn:oasis:names:tc:SAML:2.0:metadata'
const redirectBinding = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
const configurationKey = randomBytes(32)
const invalid = { kind: 'invalid', message: 'invalid_request' }
let original: ReturnType<typeof samlSigningIdentity>
let rotated: ReturnType<typeof samlSigningIdentity>

beforeAll(() => {
  original = samlSigningIdentity('login.example.com')
  rotated = samlSigningIdentity('login-rotation.example.com')
})

function idpMetadata(keys: string, extension = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="${metadataNamespace}" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entityId}">
  ${extension}
  <md:IDPSSODescriptor protocolSupportEnumeration="${protocolNamespace}">
    ${keys}
    <md:SingleSignOnService Binding="${redirectBinding}" Location="${ssoUrl}"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://login.example.com/post"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`
}

function keyDescriptor(signingCertificate: string, use = 'signing') {
  return `<md:KeyDescriptor use="${use}"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${signingCertificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`
}

describe('SAML IdP metadata configuration', () => {
  it('pins signing keys from the expected IdP role and replaces pins only on explicit refresh', async () => {
    const transport = vi.fn(async () =>
      expect.unreachable('Pasted XML requires no outbound request'),
    )
    const initial = await resolveSamlProviderInput(
      {
        metadataDocument: idpMetadata(
          keyDescriptor(original.base64) + keyDescriptor(rotated.base64, 'encryption'),
        ),
      },
      { transport },
    )
    expect(initial).toEqual({
      entityId,
      configuration: { ssoEndpoint: ssoUrl, signingCertificates: [original.base64] },
    })
    const metadataWithoutKeyInfo = idpMetadata('<md:KeyDescriptor use="signing"/>')
    await expect(
      resolveSamlProviderInput(
        { metadataDocument: metadataWithoutKeyInfo },
        { current: initial, transport },
      ),
    ).rejects.toMatchObject(invalid)

    const overlap = await resolveSamlProviderInput(
      {
        metadataDocument: metadataWithoutKeyInfo,
        signingCertificates: [original.pem, rotated.pem],
      },
      { current: initial, transport },
    )
    expect(overlap.configuration.signingCertificates).toEqual(
      [original.base64, rotated.base64].sort(),
    )
    const final = await resolveSamlProviderInput(
      { metadataDocument: idpMetadata(keyDescriptor(rotated.base64)) },
      { current: overlap, transport },
    )
    expect(final.configuration.signingCertificates).toEqual([rotated.base64])
    expect(transport).not.toHaveBeenCalled()
  })

  it('uses only the guarded outbound transport for downloads, with the operator targets', async () => {
    const privateTargets = [{ host: 'idp.internal', port: 8443 }]
    const body = Buffer.from(idpMetadata(keyDescriptor(original.base64)))
    const transport = vi.fn(async (_input: SsoRequest) => ({
      status: 200,
      contentType: 'application/xml',
      body,
    }))
    await expect(
      resolveSamlProviderInput({ metadataUrl }, { privateTargets, transport }),
    ).resolves.toMatchObject({ entityId })
    expect(transport).toHaveBeenCalledExactlyOnceWith({
      method: 'GET',
      url: metadataUrl,
      privateTargets,
      headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
    })

    transport.mockClear()
    await expect(
      resolveSamlProviderInput(
        { metadataUrl: 'https://idp.internal:8443/metadata' },
        { transport },
      ),
    ).rejects.toMatchObject(invalid)
    expect(transport).not.toHaveBeenCalled()
    for (const response of [
      { status: 302, body },
      { status: 200, body: Buffer.alloc(samlMaximumResponseBytes + 1) },
      { status: 200, body: Buffer.from([0xc0, 0x80]) },
    ]) {
      transport.mockResolvedValueOnce({ contentType: 'application/xml', ...response })
      await expect(resolveSamlProviderInput({ metadataUrl }, { transport })).rejects.toMatchObject(
        invalid,
      )
    }
    transport.mockRejectedValueOnce(new SsoTransportError('destination_refused'))
    await expect(resolveSamlProviderInput({ metadataUrl }, { transport })).rejects.toMatchObject(
      invalid,
    )
    expect(transport).toHaveBeenCalledTimes(4)
  })

  it('imports metadata with comments around the entity and inside certificate text', async () => {
    const certificate = `${original.base64.slice(0, 12)}<!-- signing key -->${original.base64.slice(12)}`
    const metadataDocument = `${idpMetadata(keyDescriptor(certificate)).replace(
      '?>',
      '?>\n<!-- Example parameters: a=1&b=2 -->',
    )}\n<!-- End of metadata -->`
    await expect(resolveSamlProviderInput({ metadataDocument })).resolves.toEqual({
      entityId,
      configuration: { ssoEndpoint: ssoUrl, signingCertificates: [original.base64] },
    })
  })

  it('refuses DTD markup, undeclared entities and XML past the byte limit', async () => {
    const document = idpMetadata(keyDescriptor(original.base64))
    const plain = document.slice(document.indexOf('<md:EntityDescriptor'))
    for (const metadataDocument of [
      `<!DOCTYPE EntityDescriptor>${plain}`,
      plain.replace(entityId, '&fixture;'),
      plain.replace(
        '</md:EntityDescriptor>',
        `${'x'.repeat(samlMaximumResponseBytes)}</md:EntityDescriptor>`,
      ),
    ]) {
      await expect(resolveSamlProviderInput({ metadataDocument })).rejects.toMatchObject(invalid)
    }
  })

  it('rejects an otherwise valid document exceeding the shared XML depth limit', async () => {
    const extension = `<md:Extensions>${'<fixture>'.repeat(28)}${'</fixture>'.repeat(28)}</md:Extensions>`
    await expect(
      resolveSamlProviderInput({
        metadataDocument: idpMetadata(keyDescriptor(original.base64), extension),
      }),
    ).rejects.toMatchObject(invalid)
  })

  it('refuses mismatched identity, ambiguous descriptors and unusable redirects', async () => {
    const document = idpMetadata(keyDescriptor(original.base64))
    const input = { metadataDocument: document, wantAssertionsSigned: true } as const
    const current = await resolveSamlProviderInput(input)
    await expect(
      resolveSamlProviderInput({ ...input, entityId: 'urn:example:different' }),
    ).rejects.toMatchObject(invalid)
    await expect(
      resolveSamlProviderInput(
        { metadataDocument: document.replace(entityId, 'urn:example:different') },
        { current },
      ),
    ).rejects.toMatchObject(invalid)
    await expect(
      resolveSamlProviderInput({ ...input, ssoUrl: `${ssoUrl}/different` }),
    ).rejects.toMatchObject(invalid)
    for (const metadataDocument of [
      document.replace(/IDPSSODescriptor/g, 'SPSSODescriptor'),
      document.replace(redirectBinding, 'urn:example:not-a-redirect-binding'),
      document.replace(ssoUrl, 'https://idp.internal/redirect'),
      document.replace(ssoUrl, `${ssoUrl}?SAMLRequest=reserved`),
      document.replace(
        '</md:IDPSSODescriptor>',
        `<md:SingleSignOnService Binding="${redirectBinding}" Location="${ssoUrl}/other"/></md:IDPSSODescriptor>`,
      ),
    ]) {
      await expect(resolveSamlProviderInput({ metadataDocument })).rejects.toMatchObject(invalid)
    }
  })
})

function instance(db: Db, capabilities: SsoCapabilities) {
  return createApp({
    checkDb: async () => {},
    authHandler: async () => expect.unreachable('SP metadata is mounted before Better Auth'),
    resolveCaller: async () => expect.unreachable('SP metadata needs no session'),
    publicUrl,
    ssoSamlSignIn: samlSignInRoutes({ db, capabilities, session: { secret: 'fixture-only' } }),
  })
}

const metadataPath = (providerId: string) => `/api/auth/sso/saml2/sp/metadata/${providerId}`
const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('SAML SP metadata endpoint', () => {
  let owned: TestDatabase
  let db: Db
  let organizationId: string
  let draftId: string
  let retiredId: string
  let oidcId: string

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'saml_metadata' })
    db = createDb(owned.pool)
    const seed = await owned.pool.connect()
    try {
      organizationId = (await ssoFixture(seed)).team
    } finally {
      seed.release()
    }
    const providers = await db
      .insertInto('sso_providers')
      .values([
        samlProviderValues(organizationId),
        { ...samlProviderValues(organizationId), retired_at: new Date() },
        oidcProviderValues(organizationId),
      ])
      .returning(['id', 'protocol', 'retired_at'])
      .execute()
    draftId = providers.find((row) => row.protocol === 'saml' && row.retired_at === null)?.id ?? ''
    retiredId = providers.find((row) => row.retired_at !== null)?.id ?? ''
    oidcId = providers.find((row) => row.protocol === 'oidc')?.id ?? ''
    expect([draftId, retiredId, oidcId]).not.toContain('')
  })

  afterAll(async () => owned?.drop())

  it('publishes the configured SP entity and exact ACS for a disabled draft, stable across rotation', async () => {
    const app = instance(db, { ssoOidcEnabled: false, ssoSamlEnabled: true })
    const path = metadataPath(draftId)
    const first = await app.request(`https://other.example.com${path}`, {
      headers: { 'X-Forwarded-Host': 'other.example.com', Host: 'other.example.com' },
    })
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('application/samlmetadata+xml; charset=utf-8')
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect(first.headers.getSetCookie()).toEqual([])

    const body = await first.text()
    const metadata = parseSamlXml(body)
    expect(metadata.getAttribute('entityID')).toBe(`${publicUrl}${path}`)
    expect(metadata.namespaceURI).toBe(metadataNamespace)
    const [descriptor] = Array.from(
      metadata.getElementsByTagNameNS(metadataNamespace, 'SPSSODescriptor'),
    )
    expect(descriptor?.getAttribute('WantAssertionsSigned')).toBe('true')
    const endpoints = Array.from(
      metadata.getElementsByTagNameNS(metadataNamespace, 'AssertionConsumerService'),
    )
    expect(endpoints).toHaveLength(1)
    expect(endpoints[0]?.getAttribute('Binding')).toBe(
      'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
    )
    expect(endpoints[0]?.getAttribute('Location')).toBe(
      `${publicUrl}/api/auth/sso/saml2/sp/acs/${draftId}`,
    )

    await db
      .updateTable('sso_providers')
      .set({
        revision: 2,
        configuration: sealSsoProviderConfiguration(
          configurationKey,
          { organizationId, providerId: draftId, revision: 2 },
          JSON.stringify({ ssoEndpoint: ssoUrl, signingCertificates: [rotated.base64] }),
        ),
      })
      .where('id', '=', draftId)
      .execute()
    const afterRotation = await app.request(path)
    expect(afterRotation.status).toBe(200)
    expect(await afterRotation.text()).toBe(body)
    expect(body).not.toContain(rotated.base64)

    for (const id of [oidcId, retiredId, 'unknown']) {
      const missing = await app.request(metadataPath(id))
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({ error: 'sso_not_found' })
    }
  })

  it('answers sso_disabled before storage access for known and unknown providers while hard-off', async () => {
    const app = instance(db, {
      ssoOidcEnabled: true,
      ssoSamlEnabled: false,
      ssoOperatorSetting: true,
    })
    const select = vi.spyOn(db, 'selectFrom')
    try {
      for (const id of [draftId, oidcId, 'unknown']) {
        const result = await app.request(metadataPath(id))
        expect(result.status).toBe(404)
        expect(await result.json()).toMatchObject({ error: 'sso_disabled' })
      }
      expect(select).not.toHaveBeenCalled()
    } finally {
      select.mockRestore()
    }
  })
})
