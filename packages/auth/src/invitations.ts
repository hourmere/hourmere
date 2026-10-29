import type { Db } from '@hourmere/db'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import { sql } from 'kysely'
import { z } from 'zod'
import type { AuthMiddlewareContext } from './api-keys.ts'
import { isUuid } from './organizations.ts'
import { checkTeamManagementAccess, TeamManagementError } from './team-management.ts'
import { fixedTeamRole, recipientAlreadyMember, teamRoleDenied } from './team-role-policy.ts'

export type ReserveInvitationEmail = (
  trx: Db,
  input: { userId: string; organizationId: string; email: string },
  now: Date,
) => Promise<boolean>

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
  } = {},
) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid()
  const input = body as Record<string, unknown>
  const organizationId = input.organizationId ?? actor.activeOrganizationId
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

  return db
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
            organization: { id: organizationId, name: '', slug: '', personal: false },
          },
          organizationId,
          true,
        )
      } catch (error) {
        if (error instanceof TeamManagementError) throw denied()
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
      const recipient = await trx
        .selectFrom('auth.member as m')
        .innerJoin('auth.user as u', 'u.id', 'm.userId')
        .select('m.id')
        .where('m.organizationId', '=', organizationId)
        .where(sql<string>`lower(btrim(u.email))`, '=', email)
        .executeTakeFirst()
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
      if (invitation && invitation.role !== 'member') throw denied()
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
      if (invitation && (invitation.status !== 'pending' || invitation.expiresAt <= now))
        throw ineligible()

      if (resend) {
        if (!invitation) throw ineligible()
        const generation = delivery?.generation ?? 1
        if (
          delivery &&
          delivery?.resend_request_id === requestId &&
          generation === (input.expectedGeneration as number) + 1
        )
          return result(invitation, delivery)
        if (generation !== input.expectedGeneration || delivery?.resend_request_id === requestId)
          throw conflict()
        if (generation >= 32)
          throw new APIError('CONFLICT', {
            code: 'INVITATION_GENERATION_LIMIT',
            message: 'This invitation has reached its resend limit.',
          })
        if (delivery?.state === 'sending' && delivery.lease_until && delivery.lease_until > now)
          throw new APIError('CONFLICT', {
            code: 'INVITATION_DELIVERY_BUSY',
            message: 'Invitation delivery is in progress. Try again shortly.',
          })
        // The future sender must update updated_at on every delivery attempt so
        // the post-delivery cooldown starts again even within the same generation.
        const started = new Date(
          Math.max(
            (delivery?.generation_started_at ?? invitation.createdAt).getTime(),
            (delivery?.updated_at ?? invitation.createdAt).getTime(),
          ),
        )
        if (now.getTime() - started.getTime() < 60_000)
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
      if (invitation && delivery && !resend) return result(invitation, delivery)
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
      if (invitation && invitation.expiresAt <= now) throw ineligible()
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
      // Legacy native resends changed expiresAt without changing createdAt. Missing
      // metadata uses the known 48-hour creator policy, never their inflated difference.
      const duration = Number(delivery?.expiry_duration_ms ?? lifetime)
      if (resend) {
        invitation = await trx
          .updateTable('auth.invitation')
          .set({ expiresAt: new Date(now.getTime() + duration) })
          .where('id', '=', invitation.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      }
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
      return result(invitation, delivery)
    })
}

function result<T>(
  invitation: T,
  delivery: { generation: number; state: string; attempts: number },
) {
  return {
    ...invitation,
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
