import type { ScimClaimCompletion } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent, writeSsoSecurityFailure } from '@hourmere/db/audit'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { sql } from 'kysely'
import { z } from 'zod'
import type { SsoProviderRevision } from './sso-configuration.ts'
import { normalizeSsoDomain } from './sso-domains.ts'
import { browserBindingDigest, databaseClock, sha256 } from './sso-mailbox-proof.ts'
import {
  LINK_SSO_ACCOUNT,
  lockOidcProvider,
  OidcAttemptRefused,
  type OidcTestActor,
  oidcLinkBinding,
} from './sso-oidc-attempt.ts'
import {
  expiresDuringOidcWrite,
  isOidcCompletionEnvelope,
  openOidcCompletion,
  sealOidcCompletion,
} from './sso-oidc-completion.ts'
import { normalizeOidcMailbox } from './sso-oidc-session.ts'
import type { verifyOidcIdToken } from './sso-oidc-verifier.ts'
import { samlCompleteLinkOperation } from './sso-saml-state.ts'

export { LINK_SSO_ACCOUNT }
export const OIDC_COMPLETE_LINK = 'oidcCompleteLink'
export const oidcLinkReturnPath = '/app/settings'
export class OidcLinkDomainUnverified extends OidcAttemptRefused {}

/** The current account, membership and active browser session. Take locks in team-write order. */
export async function lockOidcLinkActor(
  trx: Db,
  organizationId: string,
  actor: OidcTestActor,
  scimResourcesEnabled = false,
  lockTeamForClaim = false,
) {
  const user = await trx
    .selectFrom('auth.user')
    .select(['id', 'email'])
    .where('id', '=', actor.userId)
    .where('emailVerified', '=', true)
    .forShare()
    .executeTakeFirst()
  if (!user) throw new OidcAttemptRefused()
  const team = trx.selectFrom('auth.organization').select('id').where('id', '=', organizationId)
  const organization = await (lockTeamForClaim
    ? team.forUpdate()
    : team.forShare()
  ).executeTakeFirst()
  if (!organization) throw new OidcAttemptRefused()
  const member = await trx
    .selectFrom('auth.member')
    .select(['id', 'role'])
    .where('organizationId', '=', organizationId)
    .where('userId', '=', user.id)
    .where((eb) => eb.not(scimSuspended(organizationId, user.id, scimResourcesEnabled)))
    .forShare()
    .executeTakeFirst()
  if (!member) throw new OidcAttemptRefused()
  const session = await trx
    .selectFrom('auth.session')
    .select(sql<string>`"expiresAt"::text`.as('deadline'))
    .where('id', '=', actor.id)
    .where('userId', '=', user.id)
    .where(sql<string>`lower("activeOrganizationId")`, '=', organizationId)
    .forShare()
    .executeTakeFirst()
  if (!session) throw new OidcAttemptRefused()
  const mailbox = normalizeOidcMailbox(user.email)
  return { user, member, session, mailbox }
}

/** A new link needs a positive latest recheck, even before the verification deadline. */
export async function lockOidcLinkDomain(trx: Db, provider: SsoProviderRevision, mailbox: string) {
  const domain = normalizeSsoDomain(mailbox.slice(mailbox.lastIndexOf('@') + 1))
  if (!domain) throw new OidcLinkDomainUnverified()
  const claim = await trx
    .selectFrom('sso_domains as d')
    .innerJoin('sso_provider_domains as pd', (join) =>
      join.onRef('pd.domain_id', '=', 'd.id').onRef('pd.organization_id', '=', 'd.organization_id'),
    )
    .select(['d.id', 'd.generation', sql<string>`d.verification_expires_at::text`.as('deadline')])
    .where('pd.provider_id', '=', provider.providerId)
    .where('d.organization_id', '=', provider.organizationId)
    .where('d.name', '=', domain)
    .where('d.retired_at', 'is', null)
    .where('d.verified_at', 'is not', null)
    .where('d.last_check_outcome', '=', 'positive')
    .where('d.verification_expires_at', '>', sql<Date>`clock_timestamp()`)
    .forShare(['d', 'pd'])
    .executeTakeFirst()
  if (!claim) throw new OidcLinkDomainUnverified()
  return claim
}

const resultSchema = oidcLinkBinding.extend({ subject: z.string().min(1).max(255) })
const samlResultSchema = z.strictObject({
  requestId: z.uuidv7(),
  subject: z
    .string()
    .min(1)
    .refine((subject) => Buffer.byteLength(subject) <= 1024),
  mailboxDigest: z.hex().length(64),
})
type LinkBinding = z.infer<typeof oidcLinkBinding>
type LinkActor = {
  actor: OidcTestActor
  binding: LinkBinding
}
interface LinkDeps {
  db: Db
  configurationKey: Buffer
  scimResourcesEnabled?: boolean | undefined
}

/** Both IdP callbacks stage consent without changing the user's link. */
export async function stageSsoLinkResult(
  trx: Db,
  configurationKey: Buffer,
  provider: SsoProviderRevision,
  actor: OidcTestActor,
  binding: string,
  projection: z.infer<typeof resultSchema> | z.infer<typeof samlResultSchema>,
  issuedAt: string,
  expiresAt: Date | string,
) {
  const { id } = await trx.selectNoFrom(sql<string>`uuidv7()`.as('id')).executeTakeFirstOrThrow()
  const envelope = sealOidcCompletion(configurationKey, provider, id, binding, projection)
  await trx
    .insertInto('sso_attempts')
    .values({
      id,
      kind: 'link',
      organization_id: provider.organizationId,
      provider_id: provider.providerId,
      provider_revision: provider.revision,
      user_id: actor.userId,
      session_id: actor.id,
      browser_binding_digest: binding,
      operation: 'requestId' in projection ? samlCompleteLinkOperation : OIDC_COMPLETE_LINK,
      input_digest: sha256(envelope),
      created_at: issuedAt,
      expires_at: expiresAt,
    })
    .execute()
  return { id, envelope, expiresAt }
}

async function lockLinkContext(
  trx: Db,
  provider: SsoProviderRevision,
  { actor, binding }: LinkActor,
  scimResourcesEnabled: boolean,
  protocol: 'oidc' | 'saml' = 'oidc',
  lockTeamForClaim = false,
) {
  const context = await lockOidcLinkActor(
    trx,
    provider.organizationId,
    actor,
    scimResourcesEnabled,
    lockTeamForClaim,
  )
  const { issuer } = await lockOidcProvider(trx, provider, true, protocol)
  if (context.member.id !== binding.memberId || sha256(context.mailbox) !== binding.mailboxDigest)
    throw new OidcAttemptRefused()
  const claim = await lockOidcLinkDomain(trx, provider, context.mailbox)
  if (claim.id !== binding.domainId || claim.generation !== binding.domainGeneration)
    throw new OidcAttemptRefused()
  return { ...context, claim, issuer }
}

/** Freeze the validated IdP subject for a later explicit, same-origin completion. */
export async function stageOidcLink(
  { db, configurationKey, scimResourcesEnabled }: LinkDeps,
  provider: SsoProviderRevision,
  link: LinkActor,
  identity: Awaited<ReturnType<typeof verifyOidcIdToken>>,
  expiresAt: Date,
  browserBinding: string | undefined,
) {
  const binding = browserBindingDigest(browserBinding)
  if (
    !binding ||
    identity.email === undefined ||
    sha256(normalizeOidcMailbox(identity.email)) !== link.binding.mailboxDigest
  )
    throw new OidcAttemptRefused()
  return db.transaction().execute(async (trx) => {
    const context = await lockLinkContext(trx, provider, link, scimResourcesEnabled === true)
    const { issuedAt, deadline } = await trx
      .selectNoFrom([
        sql<string>`clock_timestamp()::text`.as('issuedAt'),
        sql<Date>`least(
          ${expiresAt}::timestamptz,
          ${identity.sessionDeadline ?? null}::timestamptz,
          ${link.binding.proofExpiresAt}::timestamptz,
          ${context.claim.deadline}::timestamptz,
          ${context.session.deadline}::timestamptz
        )`.as('deadline'),
      ])
      .executeTakeFirstOrThrow()
    if (deadline <= new Date(issuedAt)) throw new OidcAttemptRefused()
    return {
      ...(await stageSsoLinkResult(
        trx,
        configurationKey,
        provider,
        link.actor,
        binding,
        { ...link.binding, subject: identity.subject },
        issuedAt,
        deadline,
      )),
      expiresAt: deadline,
    }
  })
}

const invalid = { status: 'invalid' } as const

export async function completeOidcLink(
  {
    db,
    configurationKey,
    scimResourcesEnabled,
    scimClaims,
  }: LinkDeps & { scimClaims?: ScimClaimCompletion | undefined },
  {
    id,
    browserBinding,
    envelope,
  }: {
    id: string
    browserBinding: string | undefined
    envelope: string | undefined
  },
  readActor: () => Promise<OidcTestActor | null | undefined>,
  readSamlBinding?: (requestId: string) => unknown,
) {
  const protocol = readSamlBinding ? 'saml' : 'oidc'
  const completesScimClaim = protocol === 'oidc' && scimClaims?.link !== undefined
  const binding = browserBindingDigest(browserBinding)
  if (!binding || !isOidcCompletionEnvelope(envelope)) return invalid
  const digest = sha256(envelope)
  const attempts = (executor: Db) =>
    executor
      .selectFrom('sso_attempts')
      .where('id', '=', id)
      .where('kind', '=', 'link')
      .where('operation', '=', readSamlBinding ? samlCompleteLinkOperation : OIDC_COMPLETE_LINK)
      .where('browser_binding_digest', '=', binding)
      .where('input_digest', '=', digest)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', sql<Date>`clock_timestamp()`)
  const pending = await attempts(db)
    .select(['organization_id', 'provider_id', 'provider_revision', 'user_id', 'session_id'])
    .executeTakeFirst()
  // The shared endpoint may instead have a sign-in completion for this browser.
  if (!pending?.provider_id || pending.provider_revision === null) return undefined
  const actor = await readActor()
  if (!actor || actor.userId !== pending.user_id || actor.id !== pending.session_id) return invalid
  const provider = {
    organizationId: pending.organization_id,
    providerId: pending.provider_id,
    revision: pending.provider_revision,
  }
  let projection: z.infer<typeof resultSchema>
  let requestId: string | undefined
  try {
    const result = openOidcCompletion(configurationKey, provider, id, binding, envelope)
    if (readSamlBinding) {
      const saml = samlResultSchema.parse(result)
      requestId = saml.requestId
      const initial = oidcLinkBinding.parse(readSamlBinding(requestId))
      if (initial.mailboxDigest !== saml.mailboxDigest) return invalid
      projection = { ...initial, subject: saml.subject }
    } else projection = resultSchema.parse(result)
  } catch {
    return invalid
  }
  const details = {
    method: protocol,
    providerId: provider.providerId,
    revision: provider.revision,
    correlationId: id,
  } as const
  try {
    const result = await db.transaction().execute(async (trx) => {
      const context = await lockLinkContext(
        trx,
        provider,
        { actor, binding: projection },
        scimResourcesEnabled === true,
        protocol,
        completesScimClaim,
      )
      const attempt = await attempts(trx)
        .select(sql<string>`expires_at::text`.as('expires_at'))
        .where('user_id', '=', actor.userId)
        .where('session_id', '=', actor.id)
        .forUpdate()
        .executeTakeFirst()
      if (!attempt) return invalid
      const now = await databaseClock(trx)
      const timing = await trx
        .selectNoFrom([
          sql<boolean>`least(
          ${attempt.expires_at}::timestamptz, ${context.session.deadline}::timestamptz
        ) > ${now}::timestamptz`.as('live'),
          sql<boolean>`${context.claim.deadline}::timestamptz > ${now}::timestamptz`.as(
            'domainLive',
          ),
        ])
        .executeTakeFirstOrThrow()
      if (!timing.live) return invalid
      if (!timing.domainLive) return { status: 'domain_unverified' } as const

      const audit = auditActor({ kind: 'session', sessionId: actor.id, user: context.user })
      const claim =
        completesScimClaim && context.member.role === 'member'
          ? await scimClaims?.link?.(trx, {
              organizationId: provider.organizationId,
              userId: actor.userId,
              mailbox: context.mailbox,
              checkedAt: now,
              audit,
            })
          : undefined
      if (claim?.refused) return invalid

      await trx.updateTable('sso_attempts').set({ consumed_at: now }).where('id', '=', id).execute()
      // The unique indexes arbitrate simultaneous links of a subject or person.
      const link = await trx
        .insertInto('sso_identity_links')
        .values({
          organization_id: provider.organizationId,
          provider_id: provider.providerId,
          issuer: context.issuer,
          subject: projection.subject,
          user_id: actor.userId,
          proven_email: context.mailbox,
          email_proven_at: projection.provenAt,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst()
      if (!link) return { status: 'conflict' } as const
      await writeSsoAuditEvent(trx, {
        ...audit,
        organizationId: provider.organizationId,
        targetType: 'sso_link',
        targetId: link.id,
        action: 'sso_link.linked',
        details,
      })
      await claim?.finish?.(trx, {
        id: context.member.id,
        organizationId: provider.organizationId,
        userId: actor.userId,
      })
      if (readSamlBinding) {
        const { live } = await trx
          .selectNoFrom(
            sql<boolean>`least(
            ${attempt.expires_at}::timestamptz, ${context.claim.deadline}::timestamptz,
            ${context.session.deadline}::timestamptz
          ) > clock_timestamp()`.as('live'),
          )
          .executeTakeFirstOrThrow()
        if (!live) throw new OidcAttemptRefused()
      }
      return { status: 'linked', requestId } as const
    })
    if (result.status !== 'conflict') return result
    await writeSsoSecurityFailure(db, {
      ...details,
      ...auditActor({ kind: 'session', sessionId: actor.id, user: { id: actor.userId } }),
      organizationId: provider.organizationId,
      action: 'sso_link.conflicted',
    })
    return invalid
  } catch (error) {
    if (error instanceof OidcLinkDomainUnverified) {
      // A result may expire while the domain lock is contested.
      const live = await attempts(db).select('id').executeTakeFirst()
      return live ? ({ status: 'domain_unverified' } as const) : invalid
    }
    if (error instanceof OidcAttemptRefused || expiresDuringOidcWrite(error)) return invalid
    throw error
  }
}
