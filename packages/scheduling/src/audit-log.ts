// Reading the audit journal (docs/audit-log.md, Reading the journal) and its retention.
// One service serves REST, MCP and the CLI, so every surface authorizes and answers alike.
import { createHash } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { auditActor, writeAuditEvent } from '@hourmere/db/audit'
import { teamWriteTransaction } from '@hourmere/db/team-write'
import { sql } from 'kysely'
import { z } from 'zod'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { allowsManagedTeamOperations, lockVersionedTeamWrite } from './team-permission.ts'

export const AUDIT_PAGE_DEFAULT = 50
export const AUDIT_PAGE_MAX = 100
/** Retention bounds in days; the purge never deletes an event younger than the minimum. */
export const AUDIT_RETENTION_MIN_DAYS = 30
export const AUDIT_RETENTION_MAX_DAYS = 3650
/** Rows deleted by one purge statement, and statements per purge run. */
export const AUDIT_PURGE_BATCH = 1000
export const AUDIT_PURGE_MAX_BATCHES = 50

export const AUDIT_ACTOR_TYPES = [
  'user',
  'api_key',
  'oauth_client',
  'system',
  'scim_token',
  'scim_connection',
  'anonymous',
  'external_api_key',
  'external_oauth_client',
  'external_user',
] as const
const ACTION = /^[a-z_]+\.[a-z_]+$/

/** The filters; `from` is inclusive and `to` exclusive, both instants with an offset. */
export const AuditEventFilters = z.strictObject({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
  actorId: z.string().min(1).max(256).optional(),
  action: z.string().max(80).regex(ACTION).optional(),
  cursor: z.string().min(1).max(1024).optional(),
})
export type AuditEventFilters = z.infer<typeof AuditEventFilters>
export interface AuditEventQuery extends AuditEventFilters {
  limit?: number | undefined
}

export interface AuditEventView {
  id: string
  occurredAt: string
  action: string
  actor: { type: string; id: string | null }
  credential: {
    type: string
    apiKeyId: string | null
    apiKeyScope: string | null
    oauthClientId: string | null
    oauthGrantId: string | null
  }
  target: { type: string; id: string | null }
  details: Record<string, unknown>
  requestId: string | null
}

/** Input checked again here, so every surface gets invalid_request, never a server error. */
function valid<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success)
    throw new DomainError(
      'invalid',
      'invalid_request',
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('; ')
        .slice(0, 500),
    )
  return parsed.data
}
const denied = () => new DomainError('forbidden', 'team_management_access_denied')
const invalidCursor = () =>
  new DomainError(
    'invalid',
    'invalid_cursor',
    'The cursor is malformed or belongs to other filters or another organization',
  )

/**
 * The caller's management role in the organization they act in: a personal space's own owner,
 * or a verified team owner or admin. Everyone else gets the uniform team-management refusal,
 * whether they are a member, a former member or never belonged.
 */
async function managementRole(
  db: Db,
  principal: Principal,
  operation: 'audit.read' | 'audit.read_retention' | 'audit.update_retention',
): Promise<'owner' | 'admin'> {
  const row = await db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .leftJoin('personal_organizations as p', 'p.organization_id', 'm.organizationId')
    .leftJoin('team_member_authorizations as authorization', 'authorization.member_id', 'm.id')
    .select(['m.role', 'p.user_id', 'authorization.generation'])
    .where('m.organizationId', '=', principal.organization.id)
    .where('m.userId', '=', principal.user.id)
    .where('u.emailVerified', '=', true)
    .executeTakeFirst()
  const roles = row?.role.split(',').map((role) => role.trim()) ?? []
  if (!row) throw denied()
  if (row.user_id) {
    if (row.user_id !== principal.user.id || !roles.includes('owner')) throw denied()
    return 'owner'
  }
  const fixed = roles.includes('owner') || roles.includes('admin')
  if (!(await allowsManagedTeamOperations(db, principal, [operation], fixed, row.generation)))
    throw denied()
  if (roles.includes('owner')) return 'owner'
  if (roles.includes('admin')) return 'admin'
  throw denied()
}

const MICROSECONDS = { smallestUnit: 'microsecond', roundingMode: 'ceil' } as const
/** Stored times have microseconds, so `t >= x` equals `t >= ceil(x)` and `t < x` `t < ceil(x)`. */
function boundary(value: string | undefined): string | null {
  return value === undefined ? null : Temporal.Instant.from(value).toString(MICROSECONDS)
}
/** The instants Postgres timestamptz can hold from any input here (year 1 to 9999, UTC). */
const EARLIEST = Temporal.Instant.from('0001-01-01T00:00:00Z')
const LATEST = Temporal.Instant.from('9999-12-31T23:59:59.999999Z')
const storable = (instant: string) =>
  Temporal.Instant.compare(instant, EARLIEST) >= 0 && Temporal.Instant.compare(instant, LATEST) <= 0

interface Cursor {
  t: string
  i: string
}
function filterKey(organizationId: string, filters: AuditEventFilters) {
  const normalized = JSON.stringify([
    organizationId.toLowerCase(),
    boundary(filters.from),
    boundary(filters.to),
    filters.actorType ?? null,
    filters.actorId ?? null,
    filters.action ?? null,
  ])
  return createHash('sha256').update(normalized).digest('base64url')
}
function encodeCursor(key: string, position: Cursor) {
  return Buffer.from(JSON.stringify({ k: key, t: position.t, i: position.i })).toString('base64url')
}
function decodeCursor(value: string, key: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error()
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const cursor = z
      .strictObject({
        k: z.string(),
        t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
        i: z.string().regex(/^[1-9]\d{0,18}$/),
      })
      .parse(parsed)
    if (cursor.k !== key) throw new Error()
    if (!storable(cursor.t)) throw new Error()
    if (BigInt(cursor.i) > 9223372036854775807n) throw new Error()
    return { t: cursor.t, i: cursor.i }
  } catch {
    throw invalidCursor()
  }
}

interface Row {
  id: string
  occurred_at: string
  action: string
  actor_type: string
  actor_id: string | null
  credential_type: string
  credential_id: string | null
  credential_scope: string | null
  oauth_client_id: string | null
  oauth_grant_id: string | null
  target_type: string
  target_id: string
  details: Record<string, unknown>
  request_id: string | null
}

/**
 * What a reader sees of one row. Session IDs are private to their account, so a session
 * credential is shown by type only; nothing else is added to what the row stores.
 */
function view(row: Row): AuditEventView {
  const apiKey = row.credential_type === 'api_key'
  const oauth = row.credential_type === 'oauth'
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    action: row.action,
    actor: { type: row.actor_type, id: row.actor_id },
    credential: {
      type: row.credential_type,
      apiKeyId: apiKey ? row.credential_id : null,
      apiKeyScope: apiKey ? row.credential_scope : null,
      oauthClientId: oauth ? row.oauth_client_id : null,
      oauthGrantId: oauth ? row.oauth_grant_id : null,
    },
    target: { type: row.target_type, id: row.target_type === 'session' ? null : row.target_id },
    details: row.details,
    requestId: row.request_id,
  }
}

/**
 * The journal of the organization the caller acts in, newest first, for its personal owner or a
 * team owner/admin. Pages follow (occurred_at, id) downwards, so events written after the first
 * page never repeat or shift an earlier one. The cursor is tied to the organization and filters.
 */
export async function listAuditEvents(
  ctx: ServiceContext,
  query: AuditEventQuery,
): Promise<{ data: AuditEventView[]; nextCursor: string | null }> {
  await managementRole(ctx.db, ctx.principal, 'audit.read')
  const filters = valid(
    AuditEventFilters,
    Object.fromEntries(
      (['from', 'to', 'actorType', 'actorId', 'action', 'cursor'] as const).flatMap((field) =>
        query[field] === undefined ? [] : [[field, query[field]]],
      ),
    ),
  )
  const limit = query.limit ?? AUDIT_PAGE_DEFAULT
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_PAGE_MAX)
    throw new DomainError('invalid', 'invalid_limit', 'limit must be a whole number from 1 to 100')
  if (filters.actorId !== undefined && filters.actorType === undefined)
    throw new DomainError('invalid', 'invalid_request', 'actorId requires actorType')
  const from = boundary(filters.from)
  const to = boundary(filters.to)
  if ((from !== null && !storable(from)) || (to !== null && !storable(to)))
    throw new DomainError(
      'invalid',
      'invalid_request',
      'from and to must be between years 1 and 9999',
    )
  if (from !== null && to !== null && Temporal.Instant.compare(from, to) >= 0)
    throw new DomainError('invalid', 'invalid_range', 'from must be before to')
  const organizationId = ctx.principal.organization.id
  const key = filterKey(organizationId, filters)
  const after = filters.cursor === undefined ? null : decodeCursor(filters.cursor, key)
  const conditions = [sql`organization_id = ${organizationId}`]
  if (from !== null) conditions.push(sql`occurred_at >= ${from}::timestamptz`)
  if (to !== null) conditions.push(sql`occurred_at < ${to}::timestamptz`)
  if (filters.actorType !== undefined) conditions.push(sql`actor_type = ${filters.actorType}`)
  if (filters.actorId !== undefined) conditions.push(sql`actor_id = ${filters.actorId}`)
  if (filters.action !== undefined) conditions.push(sql`action = ${filters.action}`)
  if (after !== null)
    conditions.push(sql`(occurred_at, id) < (${after.t}::timestamptz, ${after.i}::bigint)`)
  const rows = (
    await sql<Row>`SELECT id::text AS id,
        to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
        action, actor_type, actor_id, credential_type, credential_id, credential_scope,
        oauth_client_id, oauth_grant_id, target_type, target_id, details, request_id
      FROM audit_events WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY occurred_at DESC, id DESC LIMIT ${limit + 1}`.execute(ctx.db)
  ).rows
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    data: page.map(view),
    nextCursor:
      rows.length > limit && last ? encodeCursor(key, { t: last.occurred_at, i: last.id }) : null,
  }
}

/** Days, or null to keep events forever. */
export type AuditRetentionDays = number | null

export const AuditLogSettingsUpdate = z
  .strictObject({
    retention: z.enum(['instance', 'forever', 'days']),
    retentionDays: z
      .number()
      .int()
      .min(AUDIT_RETENTION_MIN_DAYS)
      .max(AUDIT_RETENTION_MAX_DAYS)
      .optional(),
  })
  .refine((value) => (value.retention === 'days') === (value.retentionDays !== undefined), {
    message: 'retentionDays is required with retention "days" and refused otherwise',
    path: ['retentionDays'],
  })
export type AuditLogSettingsUpdate = z.infer<typeof AuditLogSettingsUpdate>

export interface AuditLogSettingsView {
  retention: 'instance' | 'forever' | 'days'
  retentionDays: number | null
  instanceRetentionDays: AuditRetentionDays
  effectiveRetentionDays: AuditRetentionDays
  canChangeRetention: boolean
}

/** Serializes one organization's retention change against the purge of that organization. */
export const auditRetentionLock = (organizationId: string) =>
  sql`hashtextextended(${`hourmere.audit-retention:${organizationId.toLowerCase()}`}, 0)`

async function readSettings(
  db: Db,
  organizationId: string,
  instance: AuditRetentionDays,
  role: 'owner' | 'admin',
): Promise<AuditLogSettingsView> {
  const row = await db
    .selectFrom('audit_log_settings')
    .select(['retention', 'retention_days'])
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  const retention = (row?.retention ?? 'instance') as AuditLogSettingsView['retention']
  const retentionDays = row?.retention_days ?? null
  return {
    retention,
    retentionDays,
    instanceRetentionDays: instance,
    effectiveRetentionDays:
      retention === 'instance' ? instance : retention === 'forever' ? null : retentionDays,
    canChangeRetention: role === 'owner',
  }
}

/** The organization's retention choice and the instance default, for its owners and admins. */
export async function getAuditLogSettings(
  ctx: ServiceContext,
  instance: AuditRetentionDays,
): Promise<AuditLogSettingsView> {
  const role = await managementRole(ctx.db, ctx.principal, 'audit.read_retention')
  return readSettings(ctx.db, ctx.principal.organization.id, instance, role)
}

export interface AuditLogSettingsContext extends ServiceContext {
  /** Session writes: bind the change to the space it was opened in (see branding). */
  prepareOrganizationWrite?: ((trx: Db) => Promise<void>) | undefined
}

/**
 * Sets how long the organization keeps its journal: the instance default, forever, or 30–3650
 * days. Only its owner (a personal space's owner or a team owner) may change it. A change is
 * recorded as `audit_log.retention_updated`; setting the current value again records nothing.
 */
export async function setAuditLogSettings(
  ctx: AuditLogSettingsContext,
  instance: AuditRetentionDays,
  input: AuditLogSettingsUpdate,
): Promise<AuditLogSettingsView> {
  const organizationId = ctx.principal.organization.id
  return teamWriteTransaction(ctx.db.transaction(), async (trx) => {
    await ctx.prepareOrganizationWrite?.(trx)
    if (ctx.principal.customRoleAuthorization?.credential && !ctx.principal.organization.personal) {
      await trx
        .selectFrom('auth.organization')
        .select('id')
        .where('id', '=', organizationId)
        .forShare()
        .executeTakeFirst()
      await lockVersionedTeamWrite(trx, ctx.principal, Date.now)
    }
    const role = await managementRole(trx, ctx.principal, 'audit.read_retention')
    if (role !== 'owner')
      throw new DomainError(
        'forbidden',
        'insufficient_role',
        'Only the personal owner or a team owner can change audit log retention',
      )
    await managementRole(trx, ctx.principal, 'audit.update_retention')
    const update = valid(AuditLogSettingsUpdate, input)
    // Waits only for a running purge batch of this organization, which is short and bounded.
    await sql`SELECT pg_advisory_xact_lock(${auditRetentionLock(organizationId)})`.execute(trx)
    const before = await readSettings(trx, organizationId, instance, role)
    const days = update.retention === 'days' ? (update.retentionDays ?? null) : null
    if (before.retention === update.retention && before.retentionDays === days) return before
    if (update.retention === 'instance')
      await trx
        .deleteFrom('audit_log_settings')
        .where('organization_id', '=', organizationId)
        .execute()
    else
      await trx
        .insertInto('audit_log_settings')
        .values({
          organization_id: organizationId,
          retention: update.retention,
          retention_days: days,
        })
        .onConflict((oc) =>
          oc.column('organization_id').doUpdateSet({
            retention: update.retention,
            retention_days: days,
            updated_at: sql`now()`,
          }),
        )
        .execute()
    await writeAuditEvent(trx, {
      organizationId,
      ...auditActor(ctx.principal),
      action: 'audit_log.retention_updated',
      targetType: 'organization',
      targetId: organizationId,
      requestId: ctx.requestId,
    })
    return readSettings(trx, organizationId, instance, role)
  })
}

export interface AuditPurgeResult {
  deleted: number
  /** Organizations skipped because their retention was being changed (retried next run). */
  skipped: number
  /** Whether the run stopped at its batch bound with more rows possibly eligible. */
  more: boolean
}

/**
 * Deletes journal events older than their organization's retention, in batches of at most
 * `batch` rows and `maxBatches` statements per run. Organizations without a choice, rows of
 * deleted organizations and instance-wide rows follow `instance`; null keeps them forever.
 * Nothing younger than AUDIT_RETENTION_MIN_DAYS is ever deleted. It never waits on a lock: an
 * organization whose retention is being changed is skipped, rows locked by anything else are
 * skipped, and a statement that would wait for a table lock gives up. Running it again, also
 * concurrently, deletes nothing twice.
 */
export async function purgeAuditEvents(
  db: Db,
  {
    instance,
    batch = AUDIT_PURGE_BATCH,
    maxBatches = AUDIT_PURGE_MAX_BATCHES,
    signal,
  }: {
    instance: AuditRetentionDays
    batch?: number
    maxBatches?: number
    signal?: AbortSignal | undefined
  },
): Promise<AuditPurgeResult> {
  const result: AuditPurgeResult = { deleted: 0, skipped: 0, more: false }
  // Organizations with an event past their own retention, found by an index skip scan over
  // (organization_id, occurred_at): only those cost a batch, so organizations that keep
  // everything, or whose old events are still within their period, never use up a run.
  // Null (instance-wide rows) follows the instance default.
  const instanceDays = instance === null ? null : Math.max(instance, AUDIT_RETENTION_MIN_DAYS)
  const discovered = await db
    .transaction()
    .execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '100ms'`.execute(trx)
      return (
        await sql<{ organization_id: string | null }>`WITH RECURSIVE orgs AS (
            (SELECT organization_id FROM audit_events WHERE organization_id IS NOT NULL
              ORDER BY organization_id LIMIT 1)
            UNION ALL
            SELECT (SELECT organization_id FROM audit_events
                    WHERE organization_id > orgs.organization_id
                    ORDER BY organization_id LIMIT 1)
            FROM orgs WHERE orgs.organization_id IS NOT NULL
          ), kept AS (
            SELECT orgs.organization_id,
              CASE WHEN s.retention = 'forever' THEN NULL
                   WHEN s.retention = 'days' THEN greatest(s.retention_days, ${AUDIT_RETENTION_MIN_DAYS})
                   ELSE ${instanceDays}::int END AS days
            FROM orgs LEFT JOIN audit_log_settings s ON s.organization_id = orgs.organization_id
            WHERE orgs.organization_id IS NOT NULL
          )
          SELECT organization_id FROM kept WHERE days IS NOT NULL
            AND EXISTS (SELECT 1 FROM audit_events e WHERE e.organization_id = kept.organization_id
                        AND e.occurred_at < statement_timestamp() - make_interval(days => days))
          UNION ALL
          SELECT NULL WHERE ${instanceDays}::int IS NOT NULL
            AND EXISTS (SELECT 1 FROM audit_events WHERE organization_id IS NULL
                        AND occurred_at < statement_timestamp() - make_interval(days => ${instanceDays}::int))`.execute(
          trx,
        )
      ).rows.map((row) => row.organization_id)
    })
    .catch((error: { code?: unknown }) => {
      // lock_not_available: a table lock is held; try again on the next run.
      if (error.code === '55P03') return null
      throw error
    })
  if (discovered === null) return { ...result, skipped: 1, more: true }
  const organizations = discovered
  let pending = organizations
  let batches = 0
  // One batch per organization per pass, so a large backlog cannot starve the others.
  while (pending.length > 0) {
    const next: (string | null)[] = []
    for (const organizationId of pending) {
      if (signal?.aborted || batches >= maxBatches) {
        result.more = true
        return result
      }
      batches += 1
      const outcome = await purgeBatch(db, organizationId, instance, batch)
      if (outcome === 'skipped') result.skipped += 1
      else {
        result.deleted += outcome
        if (outcome === batch) next.push(organizationId)
      }
    }
    pending = next
  }
  return result
}

async function purgeBatch(
  db: Db,
  organizationId: string | null,
  instance: AuditRetentionDays,
  batch: number,
): Promise<number | 'skipped'> {
  try {
    return await db.transaction().execute(async (trx) => {
      // Give up rather than queue behind a table lock (for example a migration).
      await sql`SET LOCAL lock_timeout = '100ms'`.execute(trx)
      let days = instance
      if (organizationId !== null) {
        const locked = await sql<{
          locked: boolean
        }>`SELECT pg_try_advisory_xact_lock_shared(${auditRetentionLock(organizationId)}) AS locked`.execute(
          trx,
        )
        if (!locked.rows[0]?.locked) return 'skipped'
        const setting = await trx
          .selectFrom('audit_log_settings')
          .select(['retention', 'retention_days'])
          .where('organization_id', '=', organizationId)
          .executeTakeFirst()
        if (setting) days = setting.retention === 'forever' ? null : setting.retention_days
      }
      if (days === null) return 0
      const keep = Math.max(days, AUDIT_RETENTION_MIN_DAYS)
      const scope =
        organizationId === null
          ? sql`organization_id IS NULL`
          : sql`organization_id = ${organizationId}`
      const deleted = await sql`DELETE FROM audit_events WHERE id IN (
          SELECT id FROM audit_events
          WHERE ${scope} AND occurred_at < statement_timestamp() - make_interval(days => ${keep})
          ORDER BY occurred_at, id LIMIT ${batch} FOR UPDATE SKIP LOCKED)`.execute(trx)
      return Number(deleted.numAffectedRows ?? 0)
    })
  } catch (error) {
    // lock_not_available: a table lock is held; try again on the next run.
    if ((error as { code?: unknown }).code === '55P03') return 'skipped'
    throw error
  }
}
