import { randomBytes } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { type SsoRequest, ssoUrl } from '@hourmere/outbound/sso'
import { DOMImplementation, XMLSerializer } from '@xmldom/xmldom'
import { sql } from 'kysely'
import { Constants, IdentityProvider, ServiceProvider } from 'samlify'
import { openSsoProviderConfiguration, type SsoProviderRevision } from './sso-configuration.ts'
import { browserBindingDigest, sha256 } from './sso-mailbox-proof.ts'
import { authenticationAttemptLifetime } from './sso-oidc-limits.ts'
import { samlDatabaseInstantText, samlDatabaseNow, samlRequestExpired } from './sso-saml-replay.ts'
import {
  samlProviderConfig,
  samlServiceProviderUrls,
  samlStartOperation,
} from './sso-saml-state.ts'

const { binding: samlBinding, format, names } = Constants.namespace
const reservedRedirectParameters = new Set([
  ...Object.values(Constants.wording.urlParams).map((key) => key.toLowerCase()),
  'samlencoding',
])

export class SamlStartRefused extends Error {
  constructor() {
    super('SAML sign-in refused')
    this.name = 'SamlStartRefused'
  }
}

interface SamlStartDependencies {
  db: Db
  configurationKey: Buffer
  privateTargets: SsoRequest['privateTargets']
  publicUrl: string
}

type SamlStartProvider = SsoProviderRevision & { issuer: string; configuration: Buffer }

function redirectIdentityProvider(issuer: string, location: string) {
  // Build metadata locally from the pinned settings. Passing metadata lets samlify
  // use the redirect endpoint without expecting a SingleLogoutService.
  const metadata = new DOMImplementation().createDocument(names.metadata, 'EntityDescriptor')
  metadata.documentElement?.setAttribute('entityID', issuer)
  const descriptor = metadata.createElementNS(names.metadata, 'IDPSSODescriptor')
  descriptor.setAttribute('protocolSupportEnumeration', names.protocol)
  const endpoint = metadata.createElementNS(names.metadata, 'SingleSignOnService')
  endpoint.setAttribute('Binding', samlBinding.redirect)
  endpoint.setAttribute('Location', location)
  descriptor.appendChild(endpoint)
  metadata.documentElement?.appendChild(descriptor)
  return IdentityProvider({ metadata: new XMLSerializer().serializeToString(metadata) })
}

/** Start an SP-initiated ceremony, returning its IdP URL only after the attempt commits. */
export async function startSamlSignIn(
  { db, configurationKey, privateTargets, publicUrl }: SamlStartDependencies,
  provider: SamlStartProvider,
  browserBinding: string,
) {
  const { organizationId, providerId, revision, issuer, configuration } = provider
  const binding = browserBindingDigest(browserBinding)
  if (!binding) throw new SamlStartRefused()

  const { spEntityId: entityID, acsUrl: acs } = samlServiceProviderUrls(publicUrl, providerId)
  let idp: ReturnType<typeof IdentityProvider>
  try {
    const config = samlProviderConfig.parse(
      JSON.parse(openSsoProviderConfiguration(configurationKey, provider, configuration)),
    )
    const endpoint = ssoUrl(config.ssoEndpoint, privateTargets)
    if (!endpoint) throw new SamlStartRefused()
    const location = new URL(endpoint)
    for (const key of location.searchParams.keys()) {
      if (reservedRedirectParameters.has(key.toLowerCase())) throw new SamlStartRefused()
    }
    // Remove a bare '?' so the redirect binding can add its own query separator.
    if (!location.search) location.search = ''
    idp = redirectIdentityProvider(issuer, location.href)
  } catch {
    throw new SamlStartRefused()
  }

  return db.transaction().execute(async (trx) => {
    // Take the locks in the team-write order and hold this configuration revision until commit.
    const organization = await trx
      .selectFrom('auth.organization')
      .select('id')
      .where('id', '=', organizationId)
      .forShare()
      .executeTakeFirst()
    if (!organization) throw new SamlStartRefused()
    const current = await trx
      .selectFrom('sso_providers')
      .select('id')
      .where('id', '=', providerId)
      .where('organization_id', '=', organizationId)
      .where('protocol', '=', 'saml')
      .where('revision', '=', revision)
      .where('enabled', '=', true)
      .where('retired_at', 'is', null)
      .forShare()
      .executeTakeFirst()
    if (!current) throw new SamlStartRefused()

    const { id } = await trx.selectNoFrom(sql<string>`uuidv7()`.as('id')).executeTakeFirstOrThrow()
    // The UUID indexes the attempt. Its compact representation plus an independent secret
    // stays within the SAML binding's 80-byte RelayState limit. Store only the handle digest.
    const relayKey = Buffer.from(id.replaceAll('-', ''), 'hex').toString('base64url')
    const relayState = `${relayKey}.${randomBytes(32).toString('base64url')}`
    // Samlify's shared entity constructor supports generateID for both roles. Its
    // published ServiceProvider settings type currently declares it only on the IdP.
    const spSettings: Parameters<typeof ServiceProvider>[0] & { generateID: () => string } = {
      entityID,
      assertionConsumerService: [{ Binding: samlBinding.post, Location: acs }],
      // The XML ID is a reversible representation of the stored attempt UUID.
      generateID: () => `_${id}`,
      templateRenderer: 'strict',
      nameIDFormat: [format.unspecified],
      allowCreate: true,
      wantAssertionsSigned: true,
      allowUnsolicitedResponse: false,
    }
    const createdAt = await samlDatabaseNow(trx)
    const request = ServiceProvider(spSettings).createLoginRequest(idp, 'redirect', { relayState })
    const { expiresAt } = await trx
      .insertInto('sso_attempts')
      .values({
        id,
        kind: 'sign_in',
        operation: samlStartOperation,
        organization_id: organizationId,
        provider_id: providerId,
        provider_revision: revision,
        browser_binding_digest: binding,
        input_digest: sha256(relayState),
        created_at: createdAt.toString(),
        expires_at: createdAt.add({ seconds: authenticationAttemptLifetime }).toString(),
      })
      .returning(samlDatabaseInstantText(sql.ref('expires_at')).as('expiresAt'))
      .executeTakeFirstOrThrow()
    const now = await samlDatabaseNow(trx)
    if (samlRequestExpired(Temporal.Instant.from(expiresAt), now)) {
      throw new SamlStartRefused()
    }
    return { id, url: request.context }
  })
}
