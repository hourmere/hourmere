// SCIM User creation (RFC 7644 section 3.3): POST /Users. docs/scim.md fixes what it does: it
// records a managed provisioning entry in the connection the token is bound to and, for its
// work address, a pending claim whose invitation comes from the existing invitation service.
// An address that already has its own standing in the organization (a member's, or one
// another pending invitation holds) gets the same entry and a claim without an invitation.
// It never creates an account, a membership or a session, never marks an address verified,
// and admits nobody: the recipient proves the mailbox through the claim later.
import {
  admitInvitation,
  type EnqueueInvitationEmail,
  invitationLifetimeMs,
  invitationRefusalCode,
  type ReserveInvitationEmail,
  type SignupPolicy,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { type AuditEvent, writeAuditEvent } from '@hourmere/db/audit'
import { sql } from 'kysely'
import type { ScimReply, ScimResourceHandler, ScimResourceRequest } from './scim.ts'
import { parseScimProjection, projectScimResource, scimUserQuery } from './scim-query.ts'
import {
  invalidSyntax,
  lockScimWriteConnection,
  parseScimUserWrite,
  refuse,
  scimUserWriteError,
  validateScimManager,
} from './scim-user-write.ts'
import { readScimUser } from './scim-users.ts'

type Json = Record<string, unknown>

export interface ScimUserCreationDeps {
  db: Db
  /** The instance sign-up policy (SIGNUP and SIGNUP_ALLOWED_DOMAINS). */
  signup: SignupPolicy
  /** The invitation mail budget, as the invitation entrance of Better Auth reserves it. */
  reserve?: ReserveInvitationEmail | undefined
  /** Queues a committed delivery generation, as the invitation entrance does after commit. */
  enqueue?: EnqueueInvitationEmail | undefined
}

// An organization precondition, not a duplicate: identity providers read a create's 409 as
// "already exists".
const noInviter = () =>
  refuse(403, 'No owner of this organization with a verified email address can invite.')
// The per-recipient limit counts every organization's invitations, so the detail names none.
const invitationsLimited = () =>
  refuse(429, 'Invitation sending is limited right now. Retry later.', undefined, {
    'Retry-After': '3600',
  })

/**
 * Invitation refusals that mean the address already has its own standing in this
 * organization: it belongs to a member, or another administrator's, a legacy (a role other
 * than member) or a duplicated pending invitation holds it, or that invitation's inviter has
 * left. admitInvitation refuses each before it writes anything. The claim then records the
 * address without an invitation and nothing is sent.
 */
const HELD_ELSEWHERE = [
  'INVITATION_RECIPIENT_ALREADY_MEMBER',
  'INVITATION_ALREADY_PENDING',
  'TEAM_MANAGEMENT_ACCESS_DENIED',
  'INVITATION_CONFLICT',
  'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION',
]

/**
 * SCIM is never a sign-up authority: on a restricted instance it provisions only addresses
 * the sign-up policy already admits by domain. The decision reads no account or invitation,
 * so its answer is the same whether or not a personal account exists.
 */
function signupAdmits(policy: SignupPolicy, email: string) {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  return policy.mode === 'open' || policy.allowedDomains.includes(domain)
}

async function create(
  deps: ScimUserCreationDeps,
  request: ScimResourceRequest,
): Promise<ScimReply> {
  const projection = parseScimProjection(request.query, scimUserQuery)
  if (!projection.ok) return projection.reply
  const body = await request.body?.()
  if (!body) return invalidSyntax('The request body must be a User object.').reply
  if (!body.ok) return body.reply
  const { principal } = request
  // Attributed to the token that made the request: the actor is the credential.
  const audit: Pick<AuditEvent, 'actor' | 'credential'> = {
    actor: { type: 'scim_token', id: principal.tokenId },
    credential: { type: 'none' },
  }
  let created: {
    id: string
    representation: Json
    queued?: { invitationId: string; generation: number }
  }
  try {
    const { profile: entry, active = true } = parseScimUserWrite(body.value)
    if (entry.work_email !== null && !signupAdmits(deps.signup, entry.work_email))
      throw refuse(403, "This instance's sign-up policy does not admit this work email address.")
    created = await deps.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        const connection = await lockScimWriteConnection(trx, principal)
        await validateScimManager(trx, principal.organizationId, connection, entry.manager_id)
        // Live uniqueness is the database's: a duplicate fails here, before any invitation.
        const { id } = await trx
          .insertInto('scim_users')
          .values({
            ...entry,
            active,
            organization_id: principal.organizationId,
            connection_id: connection,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await writeAuditEvent(trx, {
          organizationId: principal.organizationId,
          ...audit,
          action: 'scim_user.created',
          targetType: 'scim_user',
          targetId: id,
        })
        let queued: { invitationId: string; generation: number } | undefined
        if (active && entry.work_email !== null) {
          const mailbox = entry.work_email.toLowerCase()
          // The earliest current owner with a verified address invites: the organization's
          // authority, whichever token or person set provisioning up, and one the invitation
          // sender accepts. The update lock keeps that owner in place. It is required for
          // every work address, so this refusal never depends on the address.
          const inviter = await trx
            .selectFrom('auth.member')
            .innerJoin('auth.user', 'auth.user.id', 'auth.member.userId')
            .select('auth.member.userId')
            .where('auth.member.organizationId', '=', principal.organizationId)
            .where(
              sql<boolean>`'owner' = ANY (SELECT btrim(token) FROM unnest(string_to_array(auth.member.role, ',')) AS token)`,
            )
            .where('auth.user.emailVerified', '=', true)
            .orderBy('auth.member.createdAt')
            .orderBy('auth.member.id')
            .executeTakeFirst()
          if (!inviter) throw noInviter()
          // Whatever admission does is kept only when the claim links its invitation.
          await sql`SAVEPOINT scim_user_invitation`.execute(trx)
          const admit = async () => {
            try {
              // No `current` check: the token was rechecked under the organization lock, so
              // TEAM_MANAGEMENT_ACCESS_DENIED can only be the refusal of a legacy role.
              return await admitInvitation(
                trx,
                { userId: inviter.userId, audit },
                {
                  organizationId: principal.organizationId,
                  email: mailbox,
                  resend: false,
                },
                { reserve: deps.reserve },
              )
            } catch (error) {
              const code = invitationRefusalCode(error)
              if (code === undefined || !HELD_ELSEWHERE.includes(code)) throw error
              return undefined
            }
          }
          let admitted: Awaited<ReturnType<typeof admitInvitation>> | undefined
          try {
            admitted = await admit()
          } catch (error) {
            // A pending invitation for the address expired while admission waited for its
            // delivery row, the mail budget or another administrator's invitation. Admission
            // runs once more from the savepoint: it then skips the expired invitation and
            // issues a new one, as the provider's retry would. It is never a claim without
            // an invitation, which would leave the person without an email.
            if (invitationRefusalCode(error) !== 'INVITATION_INELIGIBLE') throw error
            await sql`ROLLBACK TO SAVEPOINT scim_user_invitation`.execute(trx)
            admitted = await admit()
          }
          // A pending invitation another entry's claim already holds is not shared.
          if (
            admitted?.existing &&
            (await trx
              .selectFrom('scim_user_claims')
              .select('id')
              .where('invitation_id', '=', admitted.invitation.id)
              .executeTakeFirst())
          )
            admitted = undefined
          if (!admitted) await sql`ROLLBACK TO SAVEPOINT scim_user_invitation`.execute(trx)
          await sql`RELEASE SAVEPOINT scim_user_invitation`.execute(trx)
          // The same pending claim either way. Without an invitation nothing is sent and
          // the claim lasts as long as an invitation would; the SSO linking completion step
          // proves and links the person's own account.
          await trx
            .insertInto('scim_user_claims')
            .values({
              organization_id: principal.organizationId,
              connection_id: connection,
              scim_user_id: id,
              invitation_id: admitted?.invitation.id ?? null,
              work_email: mailbox,
              expires_at:
                admitted?.invitation.expiresAt ??
                sql<Date>`clock_timestamp() + make_interval(secs => ${invitationLifetimeMs / 1000}::double precision)`,
            })
            .execute()
          if (admitted?.delivery.state === 'queued')
            queued = {
              invitationId: admitted.invitation.id,
              generation: admitted.delivery.generation,
            }
        }
        const representation = await readScimUser(trx, request, id)
        if (!representation) throw new Error('The created User is not readable.')
        return { id, representation, ...(queued ? { queued } : {}) }
      })
  } catch (error) {
    const reply = scimUserWriteError(error)
    if (reply) return reply
    const code = invitationRefusalCode(error)
    if (code === 'INVITATION_RATE_LIMITED' || code === 'INVITATION_PENDING_LIMIT')
      return invitationsLimited().reply
    // Anything else rolls everything back as a server error the provider retries.
    throw error
  }
  // The entry and its delivery intent are committed. A queue outage leaves that generation
  // to the invitation repairer, so the create still succeeds.
  if (created.queued && deps.enqueue) {
    try {
      await deps.enqueue(created.queued)
    } catch {}
  }
  return {
    status: 201,
    body: projectScimResource(scimUserQuery, created.representation, projection.value),
    headers: { Location: (created.representation.meta as { location: string }).location },
  }
}

/** POST /Users for the token's connection; every other request is left to the next handler. */
export function scimUserCreation(deps: ScimUserCreationDeps): ScimResourceHandler {
  return (request) =>
    request.method === 'POST' && request.path === '/Users' ? create(deps, request) : undefined
}
