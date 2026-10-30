import type { Db } from '@hourmere/db'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import { sql } from 'kysely'
import { z } from 'zod'
import type { AuthMiddlewareContext } from './api-keys.ts'
import {
  invitationEligibilityDenial,
  invitationRecipientIsMember,
  invitationResendDeliveryDenial,
} from './invitation-resend.ts'
import { isUuid } from './organizations.ts'
import { checkTeamManagementAccess, TeamManagementError } from './team-management.ts'
import { fixedTeamRole, recipientAlreadyMember, teamRoleDenied } from './team-role-policy.ts'

export type ReserveInvitationEmail = (
  trx: Db,
  input: { userId: string; organizationId: string; email: string },
  now: Date,
) => Promise<boolean>

/** The server queues durable delivery work without importing its jobs into auth. */
export type EnqueueInvitationEmail = (payload: {
  invitationId: string
  generation: number
}) => Promise<void>

const denied = teamRoleDenied
const invalid = () =>
  new APIError('BAD_REQUEST', {
    code: 'INVALID_INVITATION_REQUEST',
    message: 'Provide a member invitation and valid resend parameters.',
  })
const conflict = () =>
  new APIError('CONFLICT', {
    code: 'INVITATION_CONFLICT',
    message: 'The invitation changed. Reload before trying again.',
  })
const ineligible = () =>
  new APIError('CONFLICT', {
    code: 'INVITATION_INELIGIBLE',
    message: 'This invitation is no longer pending. Create a new invitation if needed.',
  })
const contextChanged = () =>
  new APIError('CONFLICT', {
    code: 'ORGANIZATION_CONTEXT_CHANGED',
    message: 'Your team context changed. Reload this page before trying again.',
  })

const lifetime = 48 * 3_600_000
const wallClock = async (db: Db) =>
  (await db.selectNoFrom(sql<Date>`clock_timestamp()`.as('now')).executeTakeFirstOrThrow()).now

/**
 * The native HTTP and internal API entrance share this transaction. No global recipient account
 * lookup or sign-up-policy decision participates in invitation admission. A queued row is
 * durable request intent only; a separate sender must enforce the four-attempt budget.
 */
export async function manageInvitation(
  db: Db,
  actor: { userId: string; sessionId: string; activeOrganizationId?: string | null },
  body: unknown,
  options: {
    expectedOrganizationId?: string | null
    requireContext?: boolean
    reserve?: ReserveInvitationEmail | undefined
    enqueue?: EnqueueInvitationEmail | undefined
  } = {},
) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid()
  const input = body as Record<string, unknown>
  if (
    options.requireContext &&
    options.expectedOrganizationId !== undefined &&
    options.expectedOrganizationId !== null &&
    !isUuid(options.expectedOrganizationId)
  )
    throw denied()
  const context =
    options.requireContext && options.expectedOrganizationId
      ? { expectedOrganizationId: options.expectedOrganizationId, allowPersonal: false }
      : undefined
  const organizationId =
    input.organizationId ?? actor.activeOrganizationId ?? context?.expectedOrganizationId
  if (typeof organizationId !== 'string' || !isUuid(organizationId)) throw denied()
  if (!isUuid(actor.userId) || !isUuid(actor.sessionId)) throw denied()
  // Refuse alternate role forms and unsupported native team/subgroup parameters.
  if (fixedTeamRole(input.role === undefined ? 'member' : input.role) !== 'member') throw denied()
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'organizationId',
          'email',
          'role',
          'resend',
          'expectedGeneration',
          'requestId',
          'invitationId',
        ].includes(key),
    ) ||
    typeof input.email !== 'string' ||
    input.email.length > 254 ||
    !z.email().safeParse(input.email.trim()).success ||
    Array.from(input.email).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    !input.email.isWellFormed() ||
    (input.resend !== undefined && typeof input.resend !== 'boolean') ||
    (input.invitationId !== undefined &&
      (typeof input.invitationId !== 'string' || !isUuid(input.invitationId)))
  )
    throw invalid()
  const resend = input.resend === true
  if (
    resend &&
    (typeof input.invitationId !== 'string' ||
      !isUuid(input.invitationId) ||
      !Number.isInteger(input.expectedGeneration) ||
      (input.expectedGeneration as number) < 1 ||
      (input.expectedGeneration as number) > 32 ||
      typeof input.requestId !== 'string' ||
      !isUuid(input.requestId))
  )
    throw invalid()
  if (!resend && (input.expectedGeneration !== undefined || input.requestId !== undefined))
    throw invalid()
  const email = input.email.trim().toLowerCase()
  const requestId = typeof input.requestId === 'string' ? input.requestId.toLowerCase() : undefined

  const admitted = await db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      // One authorization path and lock order: user -> team -> membership -> session.
      try {
        await checkTeamManagementAccess(
          trx,
          {
            kind: 'session',
            user: { id: actor.userId, name: '', email: '' },
            sessionId: actor.sessionId,
            organization: {
              id: context ? (actor.activeOrganizationId ?? organizationId) : organizationId,
              name: '',
              slug: '',
              personal: false,
            },
          },
          organizationId,
          true,
          context,
        )
      } catch (error) {
        if (error instanceof TeamManagementError) {
          if (error.code === 'organization_context_changed') throw contextChanged()
          throw denied()
        }
        throw error
      }
      const session = await trx
        .selectFrom('auth.session')
        .select(['expiresAt', 'activeOrganizationId'])
        .where('id', '=', actor.sessionId)
        .where('userId', '=', actor.userId)
        .executeTakeFirst()
      let now = await wallClock(trx)
      if (!session || session.expiresAt <= now) throw denied()
      if (
        options.requireContext &&
        (options.expectedOrganizationId?.toLowerCase() !== organizationId.toLowerCase() ||
          session.activeOrganizationId?.toLowerCase() !== organizationId.toLowerCase())
      )
        throw contextChanged()

      // Team admins may already list their own members. This fixed refusal reveals
      // no account existence outside that team and prevents duplicate memberships.
      const recipient = await invitationRecipientIsMember(trx, organizationId, email)
      if (recipient) throw recipientAlreadyMember()

      let query = trx
        .selectFrom('auth.invitation')
        .selectAll()
        .where('organizationId', '=', organizationId)
        .where(sql<string>`lower(btrim(email))`, '=', email)
      if (typeof input.invitationId === 'string') query = query.where('id', '=', input.invitationId)
      else query = query.where('status', '=', 'pending').where('expiresAt', '>', now)
      const candidates = await query.orderBy('id').limit(2).forUpdate().execute()
      if (candidates.length > 1) throw conflict()
      let invitation = candidates[0]
      const existing = Boolean(invitation)
      // Preserve the role refusal before waiting for a delivery lock.
      if (
        invitation &&
        invitationEligibilityDenial(invitation, now) === 'TEAM_MANAGEMENT_ACCESS_DENIED'
      )
        throw denied()
      if (!invitation && (resend || input.invitationId !== undefined)) throw ineligible()
      let delivery = invitation
        ? await trx
            .selectFrom('invitation_deliveries')
            .selectAll()
            .where('invitation_id', '=', invitation.id)
            .forUpdate()
            .executeTakeFirst()
        : undefined
      // Row locks can wait beyond the invitation or session's remaining lifetime.
      now = await wallClock(trx)
      if (session.expiresAt <= now) throw denied()
      if (invitation && invitationEligibilityDenial(invitation, now) === 'INVITATION_INELIGIBLE')
        throw ineligible()

      if (resend) {
        if (!invitation) throw ineligible()
        const generation = delivery?.generation ?? 1
        if (
          delivery &&
          delivery?.resend_request_id === requestId &&
          generation === (input.expectedGeneration as number) + 1
        )
          return result(invitation, delivery, existing)
        if (generation !== input.expectedGeneration || delivery?.resend_request_id === requestId)
          throw conflict()
        const resendDenial = invitationResendDeliveryDenial(invitation, delivery, now)
        if (resendDenial === 'INVITATION_GENERATION_LIMIT')
          throw new APIError('CONFLICT', {
            code: 'INVITATION_GENERATION_LIMIT',
            message: 'This invitation has reached its resend limit.',
          })
        if (resendDenial === 'INVITATION_DELIVERY_BUSY')
          throw new APIError('CONFLICT', {
            code: 'INVITATION_DELIVERY_BUSY',
            message: 'Invitation delivery is in progress. Try again shortly.',
          })
        if (resendDenial === 'INVITATION_RESEND_COOLDOWN')
          throw new APIError(
            'TOO_MANY_REQUESTS',
            {
              code: 'INVITATION_RESEND_COOLDOWN',
              message: 'Wait 60 seconds before resending this invitation.',
              retryAfterSeconds: 60,
            },
            { 'Retry-After': '60' },
          )
      }
      // Ordinary retries retain the current generation, including terminal tombstones.
      if (invitation && !resend && invitation.inviterId !== actor.userId)
        throw new APIError('CONFLICT', {
          code: 'INVITATION_ALREADY_PENDING',
          message: 'An invitation is already pending. Reload before trying again.',
        })
      if (invitation && delivery && !resend) return result(invitation, delivery, existing)
      if (!invitation) {
        const pending = await trx
          .selectFrom('auth.invitation')
          .select(({ fn }) => fn.countAll<string>().as('count'))
          .where('organizationId', '=', organizationId)
          .where('status', '=', 'pending')
          .where('expiresAt', '>', now)
          .executeTakeFirstOrThrow()
        if (Number(pending.count) >= 100)
          throw new APIError('CONFLICT', {
            code: 'INVITATION_PENDING_LIMIT',
            message: 'This team has reached its pending invitation limit.',
          })
      }
      if (
        options.reserve &&
        !(await options.reserve(trx, { userId: actor.userId, organizationId, email }, now))
      )
        throw new APIError('TOO_MANY_REQUESTS', {
          code: 'INVITATION_RATE_LIMITED',
          message: 'Invitation requests are temporarily limited. Try again later.',
        })
      // A shared mail-budget lock may have waited behind another bounded send.
      now = await wallClock(trx)
      if (session.expiresAt <= now) throw denied()
      const admissionDenial = invitation ? invitationEligibilityDenial(invitation, now) : null
      if (admissionDenial === 'INVITATION_INELIGIBLE') throw ineligible()
      if (!invitation) {
        invitation = await trx
          .insertInto('auth.invitation')
          .values({
            organizationId,
            inviterId: actor.userId,
            email,
            role: 'member',
            status: 'pending',
            createdAt: now,
            expiresAt: new Date(now.getTime() + lifetime),
          })
          .returningAll()
          .executeTakeFirstOrThrow()
      }
      // Retain legacy delivery metadata without using it to renew the invitation.
      // Resending grants delivery attempts only; the business expiry stays unchanged.
      const duration = Number(delivery?.expiry_duration_ms ?? lifetime)
      const values = {
        generation: (delivery?.generation ?? (resend ? 1 : 0)) + 1,
        state: 'queued',
        attempts: 0,
        due_at: now,
        generation_started_at: now,
        expiry_duration_ms: duration,
        lease_id: null,
        lease_until: null,
        last_job_id: null,
        resend_request_id: resend ? (requestId as string) : null,
        smtp_accepted_at: null,
        last_error_code: null,
        updated_at: now,
      }
      delivery = await trx
        .insertInto('invitation_deliveries')
        .values({ invitation_id: invitation.id, ...values })
        .onConflict((oc) => oc.column('invitation_id').doUpdateSet(values))
        .returningAll()
        .executeTakeFirstOrThrow()
      return result(invitation, delivery, existing)
    })
  // Admission is already committed: queue failure must not discard the invitation or
  // its due delivery intent. The repairer can enqueue that same generation later.
  if (options.enqueue && admitted.delivery.state === 'queued') {
    try {
      await options.enqueue({
        invitationId: admitted.id,
        generation: admitted.delivery.generation,
      })
    } catch {
      // Cancellation or acceptance can win after admission commits. A fresh read
      // distinguishes that unavailable invitation from a retryable queue outage.
      let retired = false
      try {
        const current = await db
          .selectFrom('auth.invitation')
          .select(['status', 'expiresAt'])
          .select(sql<Date>`clock_timestamp()`.as('now'))
          .where('id', '=', admitted.id)
          .executeTakeFirst()
        retired = current?.status !== 'pending' || current.expiresAt <= current.now
      } catch {
        // A failed recheck cannot establish eligibility; preserve the safe queue error.
      }
      if (retired) throw ineligible()
      throw new APIError('SERVICE_UNAVAILABLE', {
        code: 'INVITATION_DELIVERY_UNAVAILABLE',
        message: 'The invitation was saved, but delivery could not be queued. Try again later.',
      })
    }
  }
  return admitted
}

function result<T>(
  invitation: T,
  delivery: { generation: number; state: string; attempts: number },
  existing: boolean,
) {
  return {
    ...invitation,
    existing,
    delivery: {
      generation: delivery.generation,
      state: delivery.state,
      attempts: delivery.attempts,
    },
  }
}

export async function invitationRules(
  ctx: AuthMiddlewareContext,
  db: Db,
  reserve?: ReserveInvitationEmail,
  enqueue?: EnqueueInvitationEmail,
) {
  if (ctx.path !== '/organization/invite-member') return
  if (ctx.request && ctx.request.headers.get('origin') !== new URL(ctx.context.baseURL).origin)
    throw denied()
  const session = await getSessionFromCtx(ctx)
  if (!session) throw denied()
  try {
    return ctx.json(
      await manageInvitation(
        db,
        {
          userId: session.user.id,
          sessionId: session.session.id,
          activeOrganizationId: (session.session as { activeOrganizationId?: string | null })
            .activeOrganizationId,
        },
        ctx.body,
        {
          requireContext: Boolean(ctx.request),
          expectedOrganizationId: ctx.request?.headers.get('x-expected-organization-id'),
          reserve,
          enqueue,
        },
      ),
    )
  } catch (error) {
    if (error instanceof APIError) throw error
    // SQL/adapter failures may include request addresses. Retain only a fixed code.
    throw new APIError('INTERNAL_SERVER_ERROR', {
      code: 'INVITATION_REQUEST_FAILED',
      message: 'The invitation request could not be completed. Try again later.',
    })
  }
}
