import { randomBytes } from 'node:crypto'
import type { Db } from '@hourmere/db'
import type { SsoRequest } from '@hourmere/outbound/sso'
import { DOMImplementation, XMLSerializer } from '@xmldom/xmldom'
import { sql } from 'kysely'
import { Constants, IdentityProvider, ServiceProvider } from 'samlify'
import { openSsoProviderConfiguration, type SsoProviderRevision } from './sso-configuration.ts'
import { browserBindingDigest, sha256 } from './sso-mailbox-proof.ts'
import {
  lockOidcProvider,
  lockSsoStepUpTarget,
  OidcAttemptRefused,
  type OidcTestActor,
} from './sso-oidc-attempt.ts'
import { authenticationAttemptLifetime } from './sso-oidc-limits.ts'
import { samlIdentityProviderRedirectUrl } from './sso-saml-configuration.ts'
import { samlDatabaseInstantText, samlDatabaseNow, samlRequestExpired } from './sso-saml-replay.ts'
import {
  samlLinkOperation,
  samlProviderConfig,
  samlServiceProviderUrls,
  samlStartOperation,
  samlStepUpOperation,
  samlTestOperation,
} from './sso-saml-state.ts'

const { binding: samlBinding, format, names } = Constants.namespace

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
  scimResourcesEnabled?: boolean | undefined
}

type SamlStartProvider = SsoProviderRevision & { issuer: string; configuration: Buffer }
type SamlIntent =
  | { kind: 'test'; actor: OidcTestActor; enabled: boolean; deadline?: string | undefined }
  | { kind: 'link'; actor: OidcTestActor; deadline: string }
  | { kind: 'step_up'; actor: OidcTestActor; attemptId: string }

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

/** Start an SP-initiated login, self-link, step-up or administrator test. */
export async function startSamlSignIn(
  { db, configurationKey, privateTargets, publicUrl, scimResourcesEnabled }: SamlStartDependencies,
  provider: SamlStartProvider,
  browserBinding: string,
  intent?: SamlIntent,
) {
  const { organizationId, providerId, revision, issuer, configuration } = provider
  const binding = browserBindingDigest(browserBinding)
  if (!binding) throw new SamlStartRefused()

  const { spEntityId: entityID, acsUrl: acs } = samlServiceProviderUrls(publicUrl, providerId)
  let idp: ReturnType<typeof IdentityProvider>
  let nameIDFormat: string = format.unspecified
  try {
    const config = samlProviderConfig.parse(
      JSON.parse(openSsoProviderConfiguration(configurationKey, provider, configuration)),
    )
    const endpoint = samlIdentityProviderRedirectUrl(config.ssoEndpoint, privateTargets)
    if (!endpoint || (intent && !config.signingCertificates)) throw new SamlStartRefused()
    if (intent && intent.kind !== 'test' && !config.subjectAttribute)
      nameIDFormat = format.persistent
    idp = redirectIdentityProvider(issuer, endpoint)
  } catch {
    throw new SamlStartRefused()
  }

  const start = async (trx: Db) => {
    const target =
      intent?.kind === 'step_up'
        ? await lockSsoStepUpTarget(
            trx,
            { ...provider, browserBinding },
            intent.actor,
            intent.attemptId,
            scimResourcesEnabled === true,
            'saml',
          )
        : undefined
    if (!target)
      await lockOidcProvider(trx, provider, intent?.kind === 'test' ? intent.enabled : true, 'saml')
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
      nameIDFormat: [nameIDFormat],
      allowCreate: true,
      wantAssertionsSigned: true,
      allowUnsolicitedResponse: false,
    }
    const createdAt = await samlDatabaseNow(trx)
    const lifetime = createdAt.add({ seconds: authenticationAttemptLifetime })
    const intentDeadlineValue =
      intent?.kind === 'step_up' ? target?.attempt.expires_at : intent?.deadline
    const intentDeadline = intentDeadlineValue
      ? Temporal.Instant.from(new Date(intentDeadlineValue).toISOString())
      : undefined
    const deadline =
      intentDeadline && Temporal.Instant.compare(intentDeadline, lifetime) < 0
        ? intentDeadline
        : lifetime
    if (samlRequestExpired(deadline, createdAt)) throw new SamlStartRefused()
    const request = ServiceProvider(spSettings).createLoginRequest(idp, 'redirect', {
      relayState,
      ...(intent?.kind === 'step_up' && { forceAuthn: true }),
    })
    const { expiresAt } = await trx
      .insertInto('sso_attempts')
      .values({
        id,
        kind: intent?.kind === 'step_up' ? 'link' : (intent?.kind ?? 'sign_in'),
        operation:
          intent?.kind === 'test'
            ? samlTestOperation
            : intent?.kind === 'step_up'
              ? samlStepUpOperation
              : intent
                ? samlLinkOperation
                : samlStartOperation,
        organization_id: organizationId,
        provider_id: providerId,
        provider_revision: revision,
        ...(intent && { user_id: intent.actor.userId, session_id: intent.actor.id }),
        browser_binding_digest: binding,
        input_digest: sha256(relayState),
        created_at: createdAt.toString(),
        expires_at: deadline.toString(),
      })
      .returning(samlDatabaseInstantText(sql.ref('expires_at')).as('expiresAt'))
      .executeTakeFirstOrThrow()
    const now = await samlDatabaseNow(trx)
    if (samlRequestExpired(Temporal.Instant.from(expiresAt), now)) {
      throw new SamlStartRefused()
    }
    return { id, url: request.context, stepUpBinding: target?.binding }
  }
  try {
    return await (db.isTransaction ? start(db) : db.transaction().execute(start))
  } catch (error) {
    if (error instanceof OidcAttemptRefused) throw new SamlStartRefused()
    throw error
  }
}
