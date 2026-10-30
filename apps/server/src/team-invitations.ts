import {
  invitationRecipientIsMember,
  invitationResendDenial,
  type TeamManager,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { type InvitationMailLimits, invitationEmailBudgetAvailable } from '@hourmere/notifications'
import { DomainError } from '@hourmere/scheduling'
import { sql } from 'kysely'
import { z } from 'zod'

export type InvitationSummaryMailLimits = InvitationMailLimits & { secret: string }

export const TeamInvitationSummarySchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['pending', 'accepted', 'canceled', 'rejected', 'expired', 'unknown']),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  delivery: z.strictObject({
    state: z.enum(['queued', 'sending', 'smtp_accepted', 'failed', 'skipped', 'unknown']),
    attempts: z.number().int().min(0).max(4).nullable(),
    lastAttemptAt: z.iso.datetime().nullable(),
    lastErrorCode: z
      .enum([
        'transport_error',
        'smtp_auth',
        'smtp_temporary',
        'smtp_permanent',
        'smtp_not_configured',
        'mail_rate_limited',
        'interrupted',
        'attempts_exhausted',
        'invitation_ineligible',
        'legacy_delivery_unknown',
      ])
      .nullable(),
  }),
  resendAllowed: z.boolean(),
})

export type TeamInvitationSummary = z.infer<typeof TeamInvitationSummarySchema>

function afterId(cursor: string | undefined, organizationId: string): string | null {
  if (cursor === undefined) return null
  try {
    const parsed = z
      .tuple([z.literal(organizationId), z.uuid()])
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    return parsed[1]
  } catch {
    throw new DomainError('invalid', 'invalid_cursor', 'cursor is not valid for this team')
  }
}

/** The route authorizes the current team through teamManagementAccess.read before this query. */
export async function listTeamInvitationSummaries(
  db: Db,
  actor: TeamManager,
  input: { limit?: number | undefined; cursor?: string | undefined },
  mailLimits: InvitationSummaryMailLimits,
) {
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DomainError('invalid', 'invalid_limit', 'limit must be from 1 to 100')
  const after = afterId(input.cursor, actor.organizationId)
  const { rows } = await sql<{
    id: string
    email: string
    role: string | null
    status: string
    storedStatus: string
    createdAt: Date
    expiresAt: Date
    databaseNow: Date
    generation: number | null
    state: string | null
    attempts: number | null
    lastAttemptAt: Date | null
    lastErrorCode: string | null
    lease_until: Date | null
    generation_started_at: Date | null
    updated_at: Date | null
  }>`
    WITH invitation_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
    SELECT i.id, i.email, i.role, i.status AS "storedStatus", i."createdAt", i."expiresAt",
      CASE WHEN i.status = 'pending' AND i."expiresAt" <= invitation_clock.now
        THEN 'expired'
        WHEN i.status IN ('pending', 'accepted', 'canceled', 'rejected') THEN i.status
        ELSE 'unknown' END AS status,
      invitation_clock.now AS "databaseNow",
      d.generation, d.state, d.attempts, d.last_attempt_at AS "lastAttemptAt",
      d.last_error_code AS "lastErrorCode",
      d.lease_until, d.generation_started_at, d.updated_at
    FROM auth.invitation AS i
    CROSS JOIN invitation_clock
    LEFT JOIN public.invitation_deliveries AS d ON d.invitation_id = i.id
    WHERE i."organizationId" = ${actor.organizationId}::uuid
      AND (${after}::uuid IS NULL OR i.id > ${after}::uuid)
    ORDER BY i.id ASC
    LIMIT ${limit + 1}
  `.execute(db)

  const data: TeamInvitationSummary[] = []
  for (const row of rows.slice(0, limit)) {
    const delivery =
      row.generation === null
        ? undefined
        : {
            generation: row.generation,
            state: row.state as string,
            lease_until: row.lease_until,
            generation_started_at: row.generation_started_at as Date,
            updated_at: row.updated_at as Date,
          }
    const invitation = { ...row, status: row.storedStatus }
    const resendAllowed =
      invitationResendDenial(invitation, delivery, row.databaseNow) === null &&
      !(await invitationRecipientIsMember(db, actor.organizationId, row.email)) &&
      (await invitationEmailBudgetAvailable(
        db,
        {
          userId: actor.userId,
          organizationId: actor.organizationId,
          email: row.email,
        },
        mailLimits,
        row.databaseNow,
      ))
    // Construct and validate the whitelist; never spread native invitation or delivery rows.
    data.push(
      TeamInvitationSummarySchema.parse({
        id: row.id,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        delivery: {
          state: row.state ?? 'unknown',
          attempts: row.attempts,
          lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
          lastErrorCode: row.lastErrorCode,
        },
        resendAllowed,
      }),
    )
  }
  const last = data.at(-1)
  return {
    data,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify([actor.organizationId, last.id])).toString('base64url')
        : null,
  }
}
