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
  email: z.string(),
  status: z.enum(['pending', 'accepted', 'canceled', 'rejected', 'expired', 'unknown']),
  invalidReason: z.enum(['inviter_left']).nullable(),
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
  generation: z.number().int().min(1).max(32),
  resendDeniedReason: z
    .enum([
      'TEAM_MANAGEMENT_ACCESS_DENIED',
      'INVITATION_INELIGIBLE',
      'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION',
      'INVITATION_RECIPIENT_ALREADY_MEMBER',
      'INVITATION_GENERATION_LIMIT',
      'INVITATION_DELIVERY_BUSY',
      'INVITATION_RESEND_COOLDOWN',
      'INVITATION_RATE_LIMITED',
      'INVITATION_CONFLICT',
      'INVITATION_PENDING_LIMIT',
    ])
    .nullable(),
  resendRetryAfterSeconds: z.number().int().min(1).max(60).nullable(),
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
  input: {
    limit?: number | undefined
    cursor?: string | undefined
    status?: TeamInvitationSummary['status'] | undefined
    invitationId?: string | undefined
  },
  mailLimits: InvitationSummaryMailLimits,
) {
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DomainError('invalid', 'invalid_limit', 'limit must be from 1 to 100')
  if (
    input.status !== undefined &&
    !TeamInvitationSummarySchema.shape.status.safeParse(input.status).success
  )
    throw new DomainError(
      'invalid',
      'invalid_status',
      'status must be a known invitation lifecycle',
    )
  const status = input.status ?? null
  const after = afterId(input.cursor, actor.organizationId)
  const { rows } = await sql<{
    id: string
    email: string
    role: string | null
    status: string
    storedStatus: string
    invalidReason: 'inviter_left' | null
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
    WITH invitation_clock AS MATERIALIZED (SELECT clock_timestamp() AS now),
    summaries AS (
    SELECT i.id, i.email, i.role, i.status AS "storedStatus", i."createdAt", i."expiresAt",
      CASE WHEN i.status = 'pending' AND i."expiresAt" <= invitation_clock.now
        THEN 'expired'
        WHEN i.status IN ('pending', 'accepted', 'canceled', 'rejected') THEN i.status
        ELSE 'unknown' END AS status,
      CASE WHEN i.status = 'pending' AND NOT EXISTS (
        SELECT 1 FROM auth.member AS inviter
        WHERE inviter."organizationId" = i."organizationId"
          AND inviter."userId" = i."inviterId"
      ) THEN 'inviter_left' ELSE NULL END AS "invalidReason",
      invitation_clock.now AS "databaseNow",
      d.generation, d.state, d.attempts, d.last_attempt_at AS "lastAttemptAt",
      d.last_error_code AS "lastErrorCode",
      d.lease_until, d.generation_started_at, d.updated_at
    FROM auth.invitation AS i
    CROSS JOIN invitation_clock
    LEFT JOIN public.invitation_deliveries AS d ON d.invitation_id = i.id
    WHERE i."organizationId" = ${actor.organizationId}::uuid
      AND (${input.invitationId ?? null}::uuid IS NULL OR i.id = ${input.invitationId ?? null}::uuid)
      AND (${after}::uuid IS NULL OR i.id > ${after}::uuid)
    )
    SELECT * FROM summaries
    WHERE (${status}::text IS NULL OR status = ${status}::text)
    ORDER BY id ASC
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
    let resendDeniedReason: TeamInvitationSummary['resendDeniedReason'] = invitationResendDenial(
      invitation,
      delivery,
      row.databaseNow,
      await invitationRecipientIsMember(db, actor.organizationId, row.email),
    )
    if (row.invalidReason === 'inviter_left')
      resendDeniedReason = 'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION'
    if (resendDeniedReason === null && row.status === 'expired') {
      const duplicate = await db
        .selectFrom('auth.invitation')
        .select('id')
        .where('organizationId', '=', actor.organizationId)
        .where(sql<string>`lower(btrim(email))`, '=', row.email.trim().toLowerCase())
        .where('id', '!=', row.id)
        .where('status', '=', 'pending')
        .where('expiresAt', '>', row.databaseNow)
        .executeTakeFirst()
      const pending = await db
        .selectFrom('auth.invitation')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('organizationId', '=', actor.organizationId)
        .where('status', '=', 'pending')
        .where('expiresAt', '>', row.databaseNow)
        .executeTakeFirstOrThrow()
      if (duplicate) resendDeniedReason = 'INVITATION_CONFLICT'
      else if (Number(pending.count) >= 100) resendDeniedReason = 'INVITATION_PENDING_LIMIT'
    }
    if (
      resendDeniedReason === null &&
      !(await invitationEmailBudgetAvailable(
        db,
        {
          userId: actor.userId,
          organizationId: actor.organizationId,
          email: row.email,
        },
        mailLimits,
        row.databaseNow,
      ))
    )
      resendDeniedReason = 'INVITATION_RATE_LIMITED'
    const resendRetryAfterSeconds =
      resendDeniedReason === 'INVITATION_RESEND_COOLDOWN'
        ? Math.max(
            1,
            Math.min(
              60,
              Math.ceil(
                (60_000 -
                  (row.databaseNow.getTime() -
                    Math.max(
                      (row.generation_started_at ?? row.createdAt).getTime(),
                      (row.updated_at ?? row.createdAt).getTime(),
                    ))) /
                  1000,
              ),
            ),
          )
        : null
    // Construct and validate the whitelist; never spread native invitation or delivery rows.
    data.push(
      TeamInvitationSummarySchema.parse({
        id: row.id,
        email: row.email,
        status: row.status,
        invalidReason: row.invalidReason,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        delivery: {
          state: row.state ?? 'unknown',
          attempts: row.attempts,
          lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
          lastErrorCode: row.lastErrorCode,
        },
        resendAllowed: resendDeniedReason === null,
        generation: row.generation ?? 1,
        resendDeniedReason,
        resendRetryAfterSeconds,
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
