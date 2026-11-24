import { advanceSsoRecoveryRevision, type Principal, teamRoles } from '@hourmere/auth'
import { interfaceLanguage, localeCodes } from '@hourmere/core/language'
import type { Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent } from '@hourmere/db/audit'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { defineJob, type EnqueueOptions } from '@hourmere/jobs'
import { type Mailer, ssoRecoveryEnrollmentEmail, ssoRecoveryUseEmail } from '@hourmere/mail'
import { DomainError } from '@hourmere/scheduling'
import { HTTPException } from 'hono/http-exception'
import { sql } from 'kysely'
import { z } from 'zod'
import { requireSsoEnabled, type SsoCapabilities, ssoRetained } from './sso.ts'
import { type FreshProofDeps, runWithFreshProof } from './sso-fresh-proof.ts'
import { databaseClock } from './sso-mailbox-proof.ts'
import { EXPECTED_ORGANIZATION_HEADER, organizationContextAccess } from './team-management.ts'

export const CONFIGURE_SSO_RECOVERY = 'configureSsoRecovery'
export const ACCEPT_SSO_RECOVERY_ENROLLMENT = 'acceptSsoRecoveryEnrollment'
export const ssoRecoveryNominationLifetime = 259_200 // Seconds.

const revision = z.int().min(1).max(2_147_483_646)
const configuration = z.strictObject({ expectedRevision: revision, ownerUserId: z.uuid() })
const acceptance = z.strictObject({ expectedRevision: revision, enrollmentId: z.uuid() })
const proof = { proofAttemptId: z.uuid().optional() }
export const ConfigureSsoRecoveryInput = configuration.extend(proof)
export const AcceptSsoRecoveryEnrollmentInput = acceptance
  .omit({ enrollmentId: true })
  .extend(proof)

const jobName = 'sso-recovery-enrollment-email'
const recipient = { userId: z.uuid(), language: z.enum(localeCodes) }
const payload = z.discriminatedUnion('kind', [
  z.strictObject({
    ...recipient,
    kind: z.literal('nominated'),
    organizationId: z.uuid(),
    enrollmentId: z.uuid(),
    revision: z.int().positive().max(2_147_483_647),
  }),
  z.strictObject({ ...recipient, kind: z.literal('enrolled') }),
  z.strictObject({ ...recipient, kind: z.literal('used'), organizationId: z.uuid() }),
])
type Notice = z.infer<typeof payload>

export interface SsoRecoveryEnrollmentQueue {
  enqueue(name: typeof jobName, payload: Notice, options: EnqueueOptions): Promise<string | null>
}

export interface SsoRecoveryEnrollmentDeps extends FreshProofDeps {
  notificationQueue?: SsoRecoveryEnrollmentQueue | undefined
}

export function ssoRecoveryEnrollmentEmailJob({
  db,
  capabilities,
  publicUrl,
  mailer,
}: {
  db: Db
  capabilities: SsoCapabilities
  publicUrl: string
  mailer: Mailer
}) {
  return defineJob({
    name: jobName,
    payload,
    retry: { limit: 3, delaySeconds: 5, backoff: true, maxDelaySeconds: 60 },
    handler: async (notice, { signal }) => {
      // Recovery use stays available while every setting is off, and its notice with it.
      // Enrollment adds trust: its notices are dropped unless a protocol is on.
      const on = capabilities.ssoOidcEnabled || capabilities.ssoSamlEnabled
      if (notice.kind === 'used' ? !ssoRetained(capabilities) : !on) return
      try {
        const user = await db
          .selectFrom('auth.user')
          .select('email')
          .where('id', '=', notice.userId)
          .where('emailVerified', '=', true)
          .executeTakeFirst()
        if (!user) return
        let link: URL | undefined
        if (notice.kind === 'nominated') {
          const pending = await db
            .selectFrom('sso_recovery_nominations')
            .select('id')
            .where('id', '=', notice.enrollmentId)
            .where('organization_id', '=', notice.organizationId)
            .where('user_id', '=', notice.userId)
            .where('expires_at', '>', sql<Date>`clock_timestamp()`)
            .executeTakeFirst()
          if (!pending) return
          link = new URL('/app/settings', publicUrl)
          link.hash = new URLSearchParams({
            ssoRecoveryEnrollment: notice.enrollmentId,
            organizationId: notice.organizationId,
            expectedRevision: String(notice.revision),
          }).toString()
        }
        if (notice.kind === 'used') {
          const owner = await ssoRecoveryTeamOwners(
            db,
            notice.organizationId,
            capabilities.scimResourcesEnabled === true,
          )
            .where('auth.member.userId', '=', notice.userId)
            .executeTakeFirst()
          if (!owner) return
          await mailer.send(ssoRecoveryUseEmail(user.email, notice.language), { signal })
        } else {
          await mailer.send(ssoRecoveryEnrollmentEmail(user.email, notice.language, link), {
            signal,
          })
        }
      } catch {
        throw new Error('SSO recovery enrollment email could not be sent')
      }
    },
  })
}

const denied = () => new DomainError('forbidden', 'team_management_access_denied')
const missing = () => new DomainError('not_found', 'sso_not_found')
const changed = () => new DomainError('conflict', 'sso_configuration_changed')

function sessionActor(deps: FreshProofDeps, principal: Principal, headers: Headers) {
  requireSsoEnabled(deps.capabilities)
  if (
    principal.kind !== 'session' ||
    principal.organization.personal ||
    headers.has('authorization') ||
    headers.get('origin') !== new URL(deps.publicUrl).origin
  )
    throw denied()
  return principal
}

async function currentOwner(trx: Db, organizationId: string, userId: string) {
  const member = await trx
    .selectFrom('auth.member')
    .select(['id', 'role'])
    .where('organizationId', '=', organizationId)
    .where('userId', '=', userId)
    .forShare()
    .executeTakeFirst()
  return member && teamRoles(member.role).includes('owner') ? member.id : undefined
}

async function notify(deps: SsoRecoveryEnrollmentDeps, trx: Db, notice: Notice) {
  const id = await deps.notificationQueue?.enqueue(jobName, notice, { transaction: trx })
  if (!id) throw new Error('SSO recovery enrollment email could not be queued')
}

export function ssoRecoveryNoticeLanguage(locale: string | null | undefined) {
  return interfaceLanguage(locale) ?? 'en'
}

async function recipientLanguage(db: Db, userId: string) {
  const profile = await db
    .selectFrom('profiles')
    .select('locale')
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return ssoRecoveryNoticeLanguage(profile?.locale)
}

export function ssoRecoveryTeamOwners(
  db: Db,
  organizationId: string,
  scimResourcesEnabled = false,
) {
  return db
    .selectFrom('auth.member')
    .leftJoin('profiles', 'profiles.user_id', 'auth.member.userId')
    .select(['auth.member.userId', 'profiles.locale'])
    .where('organizationId', '=', organizationId)
    .where((eb) => eb.not(scimSuspended(organizationId, eb.ref('userId'), scimResourcesEnabled)))
    .where(sql<boolean>`EXISTS (
      SELECT 1 FROM unnest(string_to_array(role, ',')) AS roles(token)
      WHERE btrim(token) = 'owner'
    )`)
}

export async function notifySsoRecoveryUse(
  deps: SsoRecoveryEnrollmentDeps,
  trx: Db,
  organizationId: string,
) {
  const owners = await ssoRecoveryTeamOwners(
    trx,
    organizationId,
    deps.capabilities.scimResourcesEnabled === true,
  ).execute()
  for (const { userId, locale } of owners)
    await notify(deps, trx, {
      kind: 'used',
      userId,
      organizationId,
      language: ssoRecoveryNoticeLanguage(locale),
    })
}

type EnrollmentActor = {
  principal: Extract<Principal, { kind: 'session' }>
  organizationId: string
  userId: string
  memberId: string
}

async function withRecoveryOwnerProof<T, R>(
  deps: SsoRecoveryEnrollmentDeps,
  principal: Principal,
  headers: Headers,
  request: {
    operation: typeof CONFIGURE_SSO_RECOVERY | typeof ACCEPT_SSO_RECOVERY_ENROLLMENT
    input: (z.infer<typeof configuration> | z.infer<typeof acceptance>) & {
      proofAttemptId?: string | undefined
    }
    schema: typeof configuration | typeof acceptance
    affectedUserId?: string
  },
  authorize: (trx: Db, actor: EnrollmentActor) => Promise<T>,
  mutate: (trx: Db, actor: EnrollmentActor, target: T, nextRevision: number) => Promise<R>,
) {
  const session = sessionActor(deps, principal, headers)
  const userId = session.user.id
  const organizationId = session.organization.id
  const access = organizationContextAccess(
    session,
    headers.get(EXPECTED_ORGANIZATION_HEADER) ?? undefined,
    true,
    true,
  )
  let authorized: { actor: EnrollmentActor; target: T }
  try {
    return await runWithFreshProof(
      deps,
      {
        ...request,
        headers,
        userId,
        sessionId: session.sessionId,
        organizationId,
        proofMode:
          request.operation === ACCEPT_SSO_RECOVERY_ENROLLMENT ? 'mailbox' : 'administration',
      },
      {
        authorize: async (trx) => {
          await access(trx, organizationId)
          const memberId = await currentOwner(trx, organizationId, userId)
          if (!memberId) throw denied()
          const actor = { principal: session, organizationId, userId, memberId }
          const target = await authorize(trx, actor)
          const policy = await trx
            .selectFrom('sso_policies')
            .select('policy_revision')
            .where('organization_id', '=', organizationId)
            .forUpdate()
            .executeTakeFirst()
          if ((policy?.policy_revision ?? 1) !== request.input.expectedRevision) throw changed()
          authorized = { actor, target }
        },
        mutate: async (trx) => {
          const { policy_revision } = await advanceSsoRecoveryRevision(trx, organizationId)
          return mutate(trx, authorized.actor, authorized.target, policy_revision)
        },
      },
    )
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) throw denied()
    throw error
  }
}

function nominations(trx: Db, organizationId: string, userId: string) {
  return trx
    .deleteFrom('sso_recovery_nominations')
    .where('organization_id', '=', organizationId)
    .where('user_id', '=', userId)
}

export function configureSsoRecovery(
  deps: SsoRecoveryEnrollmentDeps,
  principal: Principal,
  headers: Headers,
  input: z.infer<typeof ConfigureSsoRecoveryInput>,
) {
  const ownerUserId = input.ownerUserId.toLowerCase()
  return withRecoveryOwnerProof(
    deps,
    principal,
    headers,
    {
      operation: CONFIGURE_SSO_RECOVERY,
      input,
      schema: configuration,
      affectedUserId: ownerUserId,
    },
    async (trx, actor) => {
      const memberId =
        ownerUserId === actor.userId
          ? actor.memberId
          : await currentOwner(trx, actor.organizationId, ownerUserId)
      if (!memberId) throw missing()
      const existing = await trx
        .selectFrom('sso_recovery_owners')
        .select('user_id')
        .where('organization_id', '=', actor.organizationId)
        .where('user_id', '=', ownerUserId)
        .executeTakeFirst()
      if (existing) throw changed()
      return memberId
    },
    async (trx, { principal, organizationId, userId }, memberId, nextRevision) => {
      await nominations(trx, organizationId, ownerUserId).execute()
      const now = await databaseClock(trx)
      const pending = await trx
        .insertInto('sso_recovery_nominations')
        .values({
          organization_id: organizationId,
          user_id: ownerUserId,
          member_id: memberId,
          nominated_by_user_id: userId,
          created_at: now,
          expires_at: sql<string>`${now}::timestamptz + ${ssoRecoveryNominationLifetime} * interval '1 second'`,
        })
        .returning(['id', 'expires_at'])
        .executeTakeFirstOrThrow()
      await writeSsoAuditEvent(trx, {
        ...auditActor(principal),
        organizationId,
        targetType: 'member',
        targetId: memberId,
        action: 'sso_recovery.nominated',
        details: {},
      })
      await notify(deps, trx, {
        kind: 'nominated',
        userId: ownerUserId,
        language: await recipientLanguage(trx, ownerUserId),
        organizationId,
        enrollmentId: pending.id,
        revision: nextRevision,
      })
      return {
        enrollmentId: pending.id,
        expiresAt: new Date(pending.expires_at).toISOString(),
        policyRevision: nextRevision,
      }
    },
  )
}

export function acceptSsoRecoveryEnrollment(
  deps: SsoRecoveryEnrollmentDeps,
  principal: Principal,
  headers: Headers,
  enrollmentId: string,
  input: z.infer<typeof AcceptSsoRecoveryEnrollmentInput>,
) {
  const clock = deps.now ?? databaseClock
  return withRecoveryOwnerProof(
    deps,
    principal,
    headers,
    {
      operation: ACCEPT_SSO_RECOVERY_ENROLLMENT,
      input: { ...input, enrollmentId },
      schema: acceptance,
    },
    async (trx, { organizationId, userId, memberId }) => {
      const pending = await trx
        .selectFrom('sso_recovery_nominations')
        .select('nominated_by_user_id')
        .where('id', '=', enrollmentId)
        .where('organization_id', '=', organizationId)
        .where('user_id', '=', userId)
        .where('member_id', '=', memberId)
        .where('expires_at', '>', sql<Date>`${await clock(trx)}::timestamptz`)
        .forUpdate()
        .executeTakeFirst()
      if (!pending || !(await currentOwner(trx, organizationId, pending.nominated_by_user_id)))
        throw missing()
      return pending.nominated_by_user_id
    },
    async (trx, { principal, organizationId, userId, memberId }, nominatorId) => {
      const pending = await nominations(trx, organizationId, userId)
        .where('id', '=', enrollmentId)
        .where('expires_at', '>', sql<Date>`${await clock(trx)}::timestamptz`)
        .returning('id')
        .executeTakeFirst()
      if (!pending) throw missing()
      const added = await trx
        .insertInto('sso_recovery_owners')
        .values({
          organization_id: organizationId,
          user_id: userId,
          member_id: memberId,
          nominated_by_user_id: nominatorId,
          accepted_at: await databaseClock(trx),
        })
        .onConflict((conflict) => conflict.columns(['organization_id', 'user_id']).doNothing())
        .returning('user_id')
        .executeTakeFirst()
      if (!added) throw changed()
      await writeSsoAuditEvent(trx, {
        ...auditActor(principal),
        organizationId,
        targetType: 'member',
        targetId: memberId,
        action: 'sso_recovery.enrolled',
        details: {},
      })
      for (const recipientId of new Set([userId, nominatorId]))
        await notify(deps, trx, {
          kind: 'enrolled',
          userId: recipientId,
          language: await recipientLanguage(trx, recipientId),
        })
    },
  )
}
