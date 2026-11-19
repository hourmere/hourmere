import { randomUUID } from 'node:crypto'
import {
  checkSsoAdmissionBlocks,
  ensurePersonalOrganization,
  invitationRefusalCode,
  lockTeamInvitationAcceptance,
  maySignUp,
  type ScimClaimCompletion,
  type SignupPolicy,
  sanitizeInitialDisplayName,
  teamMembershipLimit,
  writeTeamInvitationAcceptance,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent, writeSsoSecurityFailure } from '@hourmere/db/audit'
import { sql } from 'kysely'
import type { SsoProviderRevision } from './sso-configuration.ts'
import { databaseClock } from './sso-mailbox-proof.ts'
import { lockOidcProvider, OidcAttemptRefused } from './sso-oidc-attempt.ts'
import { expiresDuringOidcWrite } from './sso-oidc-completion.ts'
import { lockOidcLinkDomain, OidcLinkDomainUnverified } from './sso-oidc-link.ts'
import { type OidcSessionRequest, oidcSignInTiming, writeOidcSession } from './sso-oidc-session.ts'

export interface OidcAdmissionPending {
  id: string
  provider: SsoProviderRevision
  issuer: string
  subject: string
  mailbox: string
  deadline?: Date | undefined
  expiresAt: Date
}

export type OidcAdmissionDecision = { kind: 'jit' } | { kind: 'invitation'; invitationId: string }

type Refusal =
  | 'invalid'
  | 'invitation_required'
  | 'invitation_invalid'
  | 'domain_unverified'
  | 'signup_disabled'
  | 'membership_limit'
  | 'blocked'
  | 'subject_conflict'

class AdmissionRefused extends Error {
  readonly status: Refusal

  constructor(status: Refusal) {
    super(status)
    this.status = status
  }
}

class SignupRejectedDuringInsert extends Error {}

const pgCode = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code

/**
 * Resolve a proved subject in its team. The caller verifies the browser capability before calling
 * this service. `lockProof` rechecks and spends that exact capability in this transaction.
 */
export async function admitOidcAccount(
  db: Db,
  { id, provider, issuer, subject, mailbox, deadline, expiresAt }: OidcAdmissionPending,
  signup: SignupPolicy,
  options: OidcSessionRequest,
  decision: OidcAdmissionDecision,
  lockProof: (trx: Db) => Promise<{ provenAt: string } | undefined>,
  /** The same SCIM claim completion native acceptance receives; production passes none. */
  scimClaims?: ScimClaimCompletion,
) {
  const { organizationId, providerId, revision } = provider
  const details = { method: 'oidc', providerId, revision, correlationId: id } as const
  const execute = (mayCreate: boolean) =>
    db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        // No preexisting account row is written here. Order invitation acceptance, JIT capacity
        // and membership removal through the same team write lock before inspecting a proof.
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', organizationId)
          .forUpdate()
          .executeTakeFirst()
        if ((await lockOidcProvider(trx, provider)).issuer !== issuer)
          throw new AdmissionRefused('invalid')
        const proof = await lockProof(trx)
        if (!proof) throw new AdmissionRefused('invalid')

        const existingAccount = () =>
          trx
            .selectFrom('auth.user')
            .select('id')
            .where(sql<string>`lower(btrim(email))`, '=', mailbox)
            .executeTakeFirst()
        if (await existingAccount()) return { status: 'link_required' } as const

        // A subject previously linked or retired during the ceremony needs explicit recovery.
        const priorLink = await trx
          .selectFrom('sso_identity_links')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('provider_id', '=', providerId)
          .where('issuer', '=', issuer)
          .where('subject', '=', subject)
          .executeTakeFirst()
        if (priorLink) throw new AdmissionRefused('subject_conflict')

        const policy = await trx
          .selectFrom('sso_policies')
          .select(['admission', 'trust_generation'])
          .where('organization_id', '=', organizationId)
          .forShare()
          .executeTakeFirst()
        if (decision.kind === 'jit' && policy?.admission !== 'jit')
          throw new AdmissionRefused('invitation_required')
        const claim = await lockOidcLinkDomain(trx, provider, mailbox)
        const userId = randomUUID()
        let invitation:
          | Awaited<ReturnType<typeof lockTeamInvitationAcceptance>>['stored']
          | undefined
        let checkedAt: string | undefined
        if (decision.kind === 'invitation') {
          try {
            const locked = await lockTeamInvitationAcceptance(trx, {
              invitationId: decision.invitationId,
              organizationId,
              userId,
              email: mailbox,
            })
            invitation = locked.stored
            checkedAt = locked.checkedAt
          } catch (error) {
            const code = invitationRefusalCode(error)
            if (code === 'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED')
              throw new AdmissionRefused('membership_limit')
            if (code !== undefined) throw new AdmissionRefused('invitation_invalid')
            throw error
          }
        } else {
          const count = await trx
            .selectFrom('auth.member')
            .select((eb) => eb.fn.countAll<string>().as('total'))
            .where('organizationId', '=', organizationId)
            .executeTakeFirstOrThrow()
          if (Number(count.total) >= teamMembershipLimit)
            throw new AdmissionRefused('membership_limit')
        }
        if (!mayCreate || !(await maySignUp(trx, signup, mailbox))) {
          // A local signup can commit between our mailbox lookup and the first-user check.
          if (await existingAccount()) return { status: 'link_required' } as const
          throw new AdmissionRefused('signup_disabled')
        }
        if (
          !(await checkSsoAdmissionBlocks(trx, {
            organizationId,
            userId,
            mailbox,
            ...(invitation && { invitationId: invitation.id }),
          }))
        )
          throw new AdmissionRefused('blocked')

        // The application pool normally has no signup settings. Give the existing trigger the
        // same policy as the auth pool for this transaction, including first-user serialization
        // and its locked recheck of any invitation that provided the signup exception.
        await sql`SELECT set_config('hourmere.signup', ${signup.mode}, true),
        set_config('hourmere.signup_allowed_domains', ${signup.allowedDomains.join(',')}, true)`.execute(
          trx,
        )
        const createdAt = await databaseClock(trx)
        const user = await trx
          .insertInto('auth.user')
          .values({
            id: userId,
            email: mailbox,
            // This transaction only runs after Hourmere's own mailbox proof.
            emailVerified: true,
            name: sanitizeInitialDisplayName(mailbox.slice(0, mailbox.lastIndexOf('@'))),
            createdAt,
            updatedAt: createdAt,
          })
          .onConflict((oc) => oc.column('email').doNothing())
          .returning(['id', 'email', 'emailVerified'])
          .executeTakeFirst()
          .catch((error: unknown) => {
            if (pgCode(error, '42501')) throw new SignupRejectedDuringInsert()
            throw error
          })
        // A local signup or another team's admission may have won the unique email race.
        if (!user) throw new SignupRejectedDuringInsert()
        await ensurePersonalOrganization(trx, user.id)

        const member = await trx
          .insertInto('auth.member')
          .values({ organizationId, userId, role: 'member', createdAt })
          .returningAll()
          .executeTakeFirstOrThrow()
        const link = await trx
          .insertInto('sso_identity_links')
          .values({
            organization_id: organizationId,
            provider_id: providerId,
            issuer,
            subject,
            user_id: userId,
            proven_email: mailbox,
            email_proven_at: proof.provenAt,
          })
          .onConflict((oc) => oc.doNothing())
          .returning(['id', 'generation', 'proven_email'])
          .executeTakeFirst()
        if (!link) throw new AdmissionRefused('subject_conflict')

        const context = {
          user,
          member,
          link,
          claim,
          trustGeneration: policy?.trust_generation ?? 1,
        }
        const timing = await oidcSignInTiming(trx, context, expiresAt, deadline, options)
        if (timing.reason === 'domain_unverified') throw new AdmissionRefused('domain_unverified')
        if (timing.reason !== undefined) throw new AdmissionRefused('invalid')
        const liveProof = await trx
          .selectFrom('sso_attempts')
          .select('id')
          .where('id', '=', id)
          .where('mailbox_proof_expires_at', '>', sql<Date>`clock_timestamp()`)
          .executeTakeFirst()
        if (!liveProof) throw new AdmissionRefused('invalid')
        const { sessionId, cookie } = await writeOidcSession(
          trx,
          provider,
          context,
          id,
          timing,
          options,
        )
        const principal = { kind: 'session', sessionId, user } as const
        const audit = { organizationId, ...auditActor(principal), details }
        await writeSsoAuditEvent(trx, {
          ...audit,
          action: 'sso_link.linked',
          targetType: 'sso_link',
          targetId: link.id,
        })
        if (invitation && checkedAt !== undefined) {
          // The signup trigger, a conflicting signup or slug allocation can have waited since
          // the invitation was locked. Check the exact stored expiry again at the transition.
          const live = await trx
            .selectFrom('auth.invitation')
            .select('id')
            .where('id', '=', invitation.id)
            .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
            .executeTakeFirst()
          if (!live) throw new AdmissionRefused('invitation_invalid')
          // The native decision for a SCIM-issued invitation, with the expiry instant the
          // invitation lock found. It runs here because its claim audit names this session; the
          // claim is still locked after the invitation, and a refusal rolls back everything.
          const claimDecision = await scimClaims?.invitation(trx, {
            organizationId,
            invitationId: invitation.id,
            userId,
            mailbox,
            checkedAt,
            audit: auditActor(principal),
          })
          if (claimDecision?.refused) throw new AdmissionRefused('blocked')
          await claimDecision?.finish?.(trx, member)
          const accepted = await writeTeamInvitationAcceptance(trx, invitation, principal)
          return { status: 'completed', cookie, invitation: accepted, member } as const
        }
        await writeSsoAuditEvent(trx, {
          ...audit,
          action: 'sso_jit.admitted',
          targetType: 'member',
          targetId: member.id,
        })
        return { status: 'completed', cookie } as const
      })

  let mayCreate = true
  let retriedDeadlock = false
  for (;;) {
    try {
      return await execute(mayCreate)
    } catch (error) {
      if (error instanceof SignupRejectedDuringInsert && mayCreate) {
        // If another signup created this address while the trigger waited, the only outcome
        // now is independent local sign-in and explicit linking.
        mayCreate = false
        continue
      }
      if (pgCode(error, '40P01') && !retriedDeadlock) {
        // Native signup can lock a qualifying invitation in another team. A cycle aborts
        // this whole transaction, including proof consumption, so one recheck is safe.
        retriedDeadlock = true
        continue
      }
      const status =
        error instanceof AdmissionRefused
          ? error.status
          : error instanceof OidcLinkDomainUnverified
            ? 'domain_unverified'
            : error instanceof OidcAttemptRefused || expiresDuringOidcWrite(error)
              ? 'invalid'
              : undefined
      if (status === undefined) throw error
      if (decision.kind === 'jit' && status !== 'invalid') {
        await writeSsoSecurityFailure(db, {
          ...details,
          organizationId,
          actor: { type: 'anonymous' },
          credential: { type: 'none' },
          action: 'sso_jit.refused',
          reason:
            status === 'domain_unverified'
              ? status
              : status === 'invitation_required'
                ? 'jit_disabled'
                : 'unclassified',
        })
      }
      return { status }
    }
  }
}
