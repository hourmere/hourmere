// Routing-form configuration and publication services (docs/routing-forms.md, step a3): draft
// create/read/update/archive with optimistic revisions, atomic immutable publication with its
// target dependencies, and a side-effect-free preview. Service entry points only: no transport
// calls them while routing is hard-off, and nothing here is exported from the package.
//
// Lock order, the same in every write path: the organization boundary (a personal
// organization's owner, the organization share lock, then the actor and member share locks),
// the form-admission advisory lock when a form is created, the request-key advisory lock when
// a create or publish carries a `requestId`, the target event types in ID order, then the form
// row. Membership management locks the organization for update before member rows, and
// event-type edits and public booking take the organization before the event type, so a
// publication waits for either of them instead of deadlocking (docs/data-model.md, "Team
// membership and host lock order"). Receipts (a later step) come after the form.
import { createHash } from 'node:crypto'
import { ApiKeyScopeError, requireActiveApiKey } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { canonicalJson } from './bookings.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { SLUG_PATTERN } from './event-types.ts'
import { isConstraintViolation, isUuid, jsonb, SQLSTATE } from './internal.ts'
import {
  cleanRoutingText,
  evaluateRoutingForm,
  FALLBACK_RULE_ID,
  ROUTING_FORM_LIMITS,
  type RoutingAnswers,
  type RoutingFormConfig,
  type RoutingQuestion,
  type RoutingRule,
  type RoutingTarget,
  RoutingValidationError,
  validateRoutingAnswers,
  validateRoutingFormConfig,
} from './routing-form-config.ts'
import {
  loadRoutingTargetEvents,
  type RoutingTargetReason,
  routingTargetProblem,
  validateRoutingTargets,
} from './routing-form-targets.ts'

/** Page size bounds of listRoutingForms. */
export const ROUTING_FORM_PAGE = { default: 50, max: 100 } as const

/** A form's draft and identity as its manager sees them. */
export interface RoutingForm {
  id: string
  slug: string
  title: string
  description: string | null
  questions: RoutingQuestion[]
  rules: RoutingRule[]
  fallback: RoutingTarget
  /** Every successful write (draft save, enable/disable, publish, archive) increments it. */
  draftRevision: number
  enabled: boolean
  publishedVersionId: string | null
  publishedVersionNumber: number | null
  createdAt: string
  updatedAt: string
}

/** A list entry: the form without its draft content. */
export type RoutingFormSummary = Omit<
  RoutingForm,
  'description' | 'questions' | 'rules' | 'fallback'
>

/** An immutable published version. */
export interface RoutingFormVersion {
  id: string
  formId: string
  versionNumber: number
  questions: RoutingQuestion[]
  rules: RoutingRule[]
  fallback: RoutingTarget
  publishedAt: string
}

export interface CreateRoutingFormInput {
  /**
   * Optional client-generated UUID for safe retries, scoped to the organization and the
   * acting credential: a retry with the same canonical input returns the form it created,
   * and the same key with other input is refused with `idempotency_key_reused`.
   */
  requestId?: unknown
  slug: unknown
  title: unknown
  description?: unknown
  /** Defaults to no questions. */
  questions?: unknown
  /** Defaults to no rules: a fallback-only form. */
  rules?: unknown
  fallback: unknown
}

/** The fields to change; the draft fields replace their stored values as a whole. */
export interface UpdateRoutingFormInput {
  expectedRevision: unknown
  slug?: unknown
  title?: unknown
  /** null or blank text removes the description. */
  description?: unknown
  questions?: unknown
  rules?: unknown
  fallback?: unknown
  /** Enabling requires a published version. */
  enabled?: unknown
}

export interface RevisionInput {
  expectedRevision: unknown
}

export interface PublishRoutingFormInput extends RevisionInput {
  /**
   * Optional client-generated UUID for safe retries, scoped like the one of creation: a
   * retry with the same form and `expectedRevision` returns the version it published, also
   * after that publication moved the revision on.
   */
  requestId?: unknown
}

export interface PreviewRoutingFormInput {
  answers: unknown
}

/** How one rule fared against the preview answers, condition by condition. */
export interface RoutingPreviewRule {
  ruleId: string
  matched: boolean
  conditions: { questionId: string; matched: boolean }[]
}

/** An author-only explanation of how the current draft routes the given answers. */
export interface RoutingFormPreview {
  draftRevision: number
  /** The first matching rule, or `fallback`. */
  matchedRuleId: string
  /**
   * The rule whose target applies: the matched rule, or `fallback` when the matched rule's
   * event cannot be routed to; null when the fallback cannot be used either.
   */
  resolvedRuleId: string | null
  /** The resolved target; null when routing would be unavailable. */
  target: RoutingTarget | null
  /** Event targets met on the way that cannot be routed to now, and why. */
  unavailableTargets: { ruleId: string; reason: RoutingTargetReason }[]
  /** The rules evaluated, in order, up to and including the matched one. */
  rules: RoutingPreviewRule[]
}

// --- Errors --------------------------------------------------------------------------------

const CHECK_VIOLATION = '23514'
const FORM_LIMIT_CONSTRAINTS = new Set(['routing_forms_quota', 'routing_forms_total_quota'])

const formNotFound = () =>
  new DomainError('not_found', 'routing_form_not_found', 'No such routing form')
const denied = () =>
  new DomainError(
    'forbidden',
    'team_management_access_denied',
    'Only the owners and admins of this team can manage its routing forms',
  )
const revisionConflict = () =>
  new DomainError(
    'conflict',
    'routing_revision_conflict',
    'The routing form changed since the given expectedRevision; reload it and try again',
  )
const keyReused = () =>
  new DomainError(
    'conflict',
    'idempotency_key_reused',
    'This requestId was already used for a different request; send a new requestId',
  )
const invalidForm = (field: string | undefined, message: string) =>
  new RoutingValidationError('invalid_routing_form', field, message)

function isCheckViolation(error: unknown, constraints: ReadonlySet<string>): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, constraint } = error as { code?: unknown; constraint?: unknown }
  return code === CHECK_VIOLATION && typeof constraint === 'string' && constraints.has(constraint)
}

/** Maps the storage guards a write can meet to the caller's mistake. */
async function withWriteErrors<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (
      isConstraintViolation(
        error,
        SQLSTATE.uniqueViolation,
        'routing_forms_organization_id_slug_key',
      )
    )
      throw new DomainError(
        'conflict',
        'slug_taken',
        'Another routing form of this organization already uses this slug',
        { cause: error },
      )
    if (isCheckViolation(error, FORM_LIMIT_CONSTRAINTS))
      throw new DomainError(
        'conflict',
        'routing_form_limit_reached',
        'This organization already keeps the maximum number of routing forms',
        { cause: error },
      )
    if (isCheckViolation(error, new Set(['routing_form_versions_quota'])))
      throw new DomainError(
        'conflict',
        'routing_form_version_limit_reached',
        'This routing form already keeps the maximum number of published versions',
        { cause: error },
      )
    throw error
  }
}

// --- Input ---------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The input object, refusing fields beyond `keys`. */
function fieldsOf(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw invalidForm(undefined, 'must be an object')
  // The unknown key itself is never echoed.
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw invalidForm(undefined, 'has an unknown field')
  return value
}

function validSlug(value: unknown): string {
  if (typeof value !== 'string' || !SLUG_PATTERN.test(value))
    throw invalidForm(
      'slug',
      'must be 1–64 lowercase letters, digits or hyphens, and start and end with a letter or digit',
    )
  return value
}

function validRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw invalidForm('expectedRevision', 'must be the positive integer draftRevision last read')
  return value
}

/** An optional request key: a UUID, compared in lowercase. */
function validRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!isUuid(value)) throw invalidForm('requestId', 'must be a UUID')
  return value.toLowerCase()
}

function validTitle(value: unknown): string {
  const max = ROUTING_FORM_LIMITS.labelLength
  const text = typeof value === 'string' ? cleanRoutingText(value, max) : undefined
  if (text === undefined)
    throw invalidForm(
      'title',
      `must be text of at most ${max} characters without control characters`,
    )
  if (text === '') throw invalidForm('title', 'must not be blank')
  return text
}

function validDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const max = ROUTING_FORM_LIMITS.messageLength
  const text = typeof value === 'string' ? cleanRoutingText(value, max, true) : undefined
  if (text === undefined)
    throw invalidForm(
      'description',
      `must be text of at most ${max} characters without control characters`,
    )
  return text === '' ? undefined : text
}

/** The draft JSON stored in routing_forms.draft: form text plus a version's content. */
interface Draft extends RoutingFormConfig {
  title: string
  description?: string
}

const DRAFT_FIELDS = ['title', 'description', 'questions', 'rules', 'fallback'] as const

function validDraft(value: Record<string, unknown>): Draft {
  const title = validTitle(value.title)
  const description = validDescription(value.description)
  const config = validateRoutingFormConfig({
    questions: value.questions,
    rules: value.rules,
    fallback: value.fallback,
  })
  return { title, ...(description === undefined ? {} : { description }), ...config }
}

/**
 * A stored draft by shape only. Only this module writes drafts, always validated; reads do
 * not validate them again, so that a later, stricter validator cannot hide a form from its
 * manager. Every save validates the whole merged draft, and publication and preview validate
 * the stored draft, so a draft that no longer passes is refused there with its field named.
 */
function storedDraft(value: unknown): Draft {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !(DRAFT_FIELDS as readonly string[]).includes(key)) ||
    typeof value.title !== 'string' ||
    (value.description !== undefined && typeof value.description !== 'string') ||
    !Array.isArray(value.questions) ||
    !Array.isArray(value.rules) ||
    !isRecord(value.fallback)
  )
    throw new Error('A stored routing form draft has an unexpected shape')
  return value as unknown as Draft
}

/** The stored draft's version content, validated as publication would. */
const validStoredConfig = (value: unknown): RoutingFormConfig =>
  configOf(validDraft(storedDraft(value) as unknown as Record<string, unknown>))

const configOf = ({ questions, rules, fallback }: Draft): RoutingFormConfig => ({
  questions,
  rules,
  fallback,
})

// --- Authority -----------------------------------------------------------------------------

/**
 * Key scopes: a read key may list and get; writes and preview need a full key. Sessions and
 * MCP OAuth grants keep their transport checks; current membership is checked below.
 */
function requireScope(ctx: ServiceContext, access: 'read' | 'write') {
  const { principal } = ctx
  if (principal.kind !== 'api_key' || principal.apiKeyScope === 'full') return
  if (access === 'read' && principal.apiKeyScope === 'read') return
  throw new ApiKeyScopeError()
}

/**
 * Current verified membership in the organization the caller acts in, rechecked on every
 * call: a personal organization is managed by its own user, a team by its current owners and
 * admins. Write paths (`lock`) share-lock the organization first, after a personal
 * organization's owner as account deletion requires (hosts.ts lockOrganization), then the
 * actor and member rows, and finally recheck an API key against revocation.
 */
async function authorize(db: Db, ctx: ServiceContext, lock: boolean): Promise<void> {
  const { principal } = ctx
  const organizationId = principal.organization.id
  if (!isUuid(principal.user.id) || !isUuid(organizationId)) throw denied()
  const personal = await db
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  if (personal && personal.user_id !== principal.user.id) throw denied()
  const verifiedActor = async () => {
    let query = db
      .selectFrom('auth.user')
      .select('emailVerified')
      .where('id', '=', principal.user.id)
    if (lock) query = query.forShare()
    if (!(await query.executeTakeFirst())?.emailVerified) throw denied()
  }
  if (personal) await verifiedActor()
  let organization = db
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', organizationId)
  if (lock) organization = organization.forShare()
  if (!(await organization.executeTakeFirst())) throw denied()
  if (!personal) await verifiedActor()
  let member = db
    .selectFrom('auth.member')
    .select('role')
    .where('organizationId', '=', organizationId)
    .where('userId', '=', principal.user.id)
  if (lock) member = member.forShare()
  const membership = await member.executeTakeFirst()
  if (!membership) throw denied()
  // Better Auth stores several roles comma-separated.
  const roles = membership.role.split(',').map((role) => role.trim())
  if (!personal && !roles.includes('owner') && !roles.includes('admin')) throw denied()
  if (lock && principal.kind === 'api_key')
    await requireActiveApiKey(db, principal, () => ctx.now().epochMilliseconds)
}

/** Serializes form admission (migration 0072): after the organization, before any row lock. */
async function lockFormAdmission(db: Db, organizationId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'hourmere.routing-form-quota:'}::text || ${organizationId}::uuid::text, 0))`.execute(
    db,
  )
}

/** Share-locks the organization's target event types in ID order. */
async function lockTargetEvents(db: Db, organizationId: string, ids: readonly string[]) {
  const sorted = [...new Set(ids.filter(isUuid))].sort()
  if (sorted.length === 0) return
  await db
    .selectFrom('event_types')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('id', 'in', sorted)
    .orderBy('id')
    .forShare()
    .execute()
}

// --- Idempotency ---------------------------------------------------------------------------

/**
 * The replay identity of a create or publish that carries a `requestId` (docs/routing-forms.md,
 * "REST, MCP and CLI contract sketch"), stored in routing_form_operations (migration 0083).
 * The key is scoped to the organization and the acting credential, like booking and
 * meeting-poll keys: a session's user, an API key or an OAuth grant, so two credentials never
 * share a key. The fingerprint covers the operation and its canonical, validated input.
 */
interface Operation {
  organizationId: string
  operation: 'create' | 'publish'
  actor: Buffer
  requestId: string
  fingerprint: Buffer
}

const digest = (domain: string, value: string) =>
  createHash('sha256').update(`hourmere.routing-form.${domain}\0${value}`, 'utf8').digest()

function operationOf(
  ctx: ServiceContext,
  operation: Operation['operation'],
  requestId: string | undefined,
  request: Record<string, unknown>,
): Operation | undefined {
  if (requestId === undefined) return undefined
  const { principal } = ctx
  const actor =
    principal.kind === 'api_key'
      ? { kind: 'api_key', id: principal.apiKeyId.toLowerCase() }
      : principal.kind === 'oauth'
        ? { kind: 'oauth', id: principal.oauthConsentId.toLowerCase() }
        : { kind: 'session', id: principal.user.id.toLowerCase() }
  return {
    organizationId: principal.organization.id,
    operation,
    actor: digest('actor', canonicalJson(actor)),
    requestId,
    fingerprint: digest(`request.${operation}`, canonicalJson(request)),
  }
}

/**
 * Serializes the writes that carry one request key, then reads its record. Retries of a key
 * queue on the advisory lock, and each reads the record the first one committed with a fresh
 * READ COMMITTED snapshot; a second lookup after the form lock instead would leave the early
 * unlocked revision check between the two lookups, where a retry would see the revision its
 * first attempt moved on. The record is share-locked so that a later version cleanup cannot
 * remove its result while the replay reads it. The same key with other input is refused; the
 * fingerprint's domain names the operation, so that includes another operation.
 */
async function lockedOperation(trx: Db, operation: Operation) {
  const key = `hourmere.routing-form-request:${operation.organizationId}:${operation.actor.toString('hex')}:${operation.requestId}`
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx)
  const previous = await trx
    .selectFrom('routing_form_operations')
    .select(['request_fingerprint', 'form_id', 'version_id'])
    .where('organization_id', '=', operation.organizationId)
    .where('actor_scope_digest', '=', operation.actor)
    .where('request_id', '=', operation.requestId)
    .forShare()
    .executeTakeFirst()
  if (previous !== undefined && !previous.request_fingerprint.equals(operation.fingerprint))
    throw keyReused()
  return previous
}

/** Records the result of a keyed write in that write's transaction, so both commit together. */
async function recordOperation(
  trx: Db,
  operation: Operation,
  formId: string,
  versionId: string | null,
) {
  await trx
    .insertInto('routing_form_operations')
    .values({
      organization_id: operation.organizationId,
      operation: operation.operation,
      actor_scope_digest: operation.actor,
      request_id: operation.requestId,
      request_fingerprint: operation.fingerprint,
      form_id: formId,
      version_id: versionId,
    })
    .execute()
}

// --- Storage -------------------------------------------------------------------------------

interface FormRow {
  id: string
  organization_id: string
  draft: unknown
  draft_revision: number
  last_version_number: number
  published_version_id: string | null
  enabled: boolean
}

/** A live (not archived) form of the organization, optionally locked for update. */
async function findForm(
  db: Db,
  organizationId: string,
  id: string,
  lock: boolean,
): Promise<FormRow> {
  if (!isUuid(id)) throw formNotFound()
  let query = db
    .selectFrom('routing_forms')
    .select([
      'id',
      'organization_id',
      'draft',
      'draft_revision',
      'last_version_number',
      'published_version_id',
      'enabled',
    ])
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .where('archived_at', 'is', null)
  if (lock) query = query.forUpdate()
  const row = await query.executeTakeFirst()
  if (!row) throw formNotFound()
  return row
}

function assertRevision(row: { draft_revision: number }, expected: number) {
  if (row.draft_revision !== expected) throw revisionConflict()
}

const UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
const utc = (ref: string) =>
  sql<string>`to_char(${sql.ref(ref)} AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)})`
/** Microsecond database text as RFC 3339 UTC, without trailing zero fractions. */
const rfc3339 = (value: string) => Temporal.Instant.from(value).toString()

function selectForms(db: Db, organizationId: string) {
  return db
    .selectFrom('routing_forms as f')
    .leftJoin('routing_form_versions as v', (join) =>
      join
        .onRef('v.id', '=', 'f.published_version_id')
        .onRef('v.form_id', '=', 'f.id')
        .onRef('v.organization_id', '=', 'f.organization_id'),
    )
    .select([
      'f.id',
      'f.slug',
      'f.draft',
      'f.draft_revision',
      'f.enabled',
      'f.published_version_id',
      'v.version_number',
      utc('f.created_at').as('created'),
      utc('f.updated_at').as('updated'),
    ])
    .where('f.organization_id', '=', organizationId)
    .where('f.archived_at', 'is', null)
}

type SelectedForm = Awaited<ReturnType<ReturnType<typeof selectForms>['executeTakeFirstOrThrow']>>

function toSummary(row: SelectedForm, draft: Draft): RoutingFormSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: draft.title,
    draftRevision: row.draft_revision,
    enabled: row.enabled,
    publishedVersionId: row.published_version_id,
    publishedVersionNumber: row.version_number ?? null,
    createdAt: rfc3339(row.created),
    updatedAt: rfc3339(row.updated),
  }
}

function toForm(row: SelectedForm): RoutingForm {
  const draft = storedDraft(row.draft)
  return {
    ...toSummary(row, draft),
    description: draft.description ?? null,
    questions: draft.questions,
    rules: draft.rules,
    fallback: draft.fallback,
  }
}

async function loadForm(db: Db, organizationId: string, id: string): Promise<RoutingForm> {
  if (!isUuid(id)) throw formNotFound()
  const row = await selectForms(db, organizationId).where('f.id', '=', id).executeTakeFirst()
  if (!row) throw formNotFound()
  return toForm(row)
}

/** A published version as stored, so a publication and its replays return the same object. */
async function loadVersion(
  db: Db,
  organizationId: string,
  formId: string,
  id: string,
): Promise<RoutingFormVersion> {
  const row = await db
    .selectFrom('routing_form_versions')
    .select([
      'id',
      'form_id',
      'version_number',
      'questions',
      'rules',
      'fallback',
      utc('published_at').as('published'),
    ])
    .where('organization_id', '=', organizationId)
    .where('form_id', '=', formId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return {
    id: row.id,
    formId: row.form_id,
    versionNumber: row.version_number,
    questions: row.questions as unknown as RoutingQuestion[],
    rules: row.rules as unknown as RoutingRule[],
    fallback: row.fallback as unknown as RoutingTarget,
    publishedAt: rfc3339(row.published),
  }
}

// --- Draft create, read, update and archive ------------------------------------------------

const CREATE_FIELDS = [
  'requestId',
  'slug',
  'title',
  'description',
  'questions',
  'rules',
  'fallback',
] as const

/**
 * Creates a disabled, unpublished form whose draft is the validated input. The draft's
 * event targets are only shape-checked here; publication checks them against current rows.
 * With a `requestId`, a retry returns the form the first request created, as it is now
 * (`routing_form_not_found` once archived), without a slug or quota check.
 */
export async function createRoutingForm(
  ctx: ServiceContext,
  input: CreateRoutingFormInput,
): Promise<RoutingForm> {
  requireScope(ctx, 'write')
  const fields = fieldsOf(input, CREATE_FIELDS)
  const slug = validSlug(fields.slug)
  const draft = validDraft({
    ...fields,
    questions: fields.questions === undefined ? [] : fields.questions,
    rules: fields.rules === undefined ? [] : fields.rules,
  })
  const operation = operationOf(ctx, 'create', validRequestId(fields.requestId), { slug, draft })
  const organizationId = ctx.principal.organization.id
  return withWriteErrors(() =>
    ctx.db
      .transaction()
      // Form admission counts with a fresh snapshot after waiting (migration 0072).
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await ctx.authorizeOrganizationWrite?.(trx, organizationId)
        await authorize(trx, ctx, true)
        await lockFormAdmission(trx, organizationId)
        // After admission, which already serializes the organization's creations, and before
        // the insert, so a retry meets neither the slug it took nor the quota.
        if (operation) {
          const previous = await lockedOperation(trx, operation)
          if (previous) return loadForm(trx, organizationId, previous.form_id)
        }
        const { id } = await trx
          .insertInto('routing_forms')
          .values({
            organization_id: organizationId,
            slug,
            created_by_user_id: ctx.principal.user.id,
            draft: jsonb(draft),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        if (operation) await recordOperation(trx, operation, id, null)
        return loadForm(trx, organizationId, id)
      }),
  )
}

/** A live form of the caller's organization with its draft. */
export async function getRoutingForm(ctx: ServiceContext, id: string): Promise<RoutingForm> {
  requireScope(ctx, 'read')
  return ctx.db.transaction().execute(async (trx) => {
    await authorize(trx, ctx, false)
    return loadForm(trx, ctx.principal.organization.id, id)
  })
}

function encodeCursor(organizationId: string, row: { created: string; id: string }) {
  return Buffer.from(JSON.stringify([organizationId, row.created, row.id])).toString('base64url')
}

function decodeCursor(organizationId: string, cursor: unknown): { created: string; id: string } {
  const invalid = () => new DomainError('invalid', 'invalid_cursor', 'cursor is not valid')
  if (typeof cursor !== 'string' || cursor.length > 512) throw invalid()
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalid()
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalid()
  const [scope, created, id] = parsed
  // A cursor continues the list it came from, in the organization it came from.
  if (scope !== organizationId || typeof created !== 'string' || !isUuid(id)) throw invalid()
  try {
    return { created: Temporal.Instant.from(created).toString(), id }
  } catch {
    throw invalid()
  }
}

/** Live forms of the caller's organization, newest first, without their draft content. */
export async function listRoutingForms(
  ctx: ServiceContext,
  input: { limit?: number | undefined; cursor?: string | undefined } = {},
): Promise<{ data: RoutingFormSummary[]; nextCursor: string | null }> {
  requireScope(ctx, 'read')
  const limit = input.limit ?? ROUTING_FORM_PAGE.default
  if (!Number.isInteger(limit) || limit < 1 || limit > ROUTING_FORM_PAGE.max)
    throw new DomainError(
      'invalid',
      'invalid_limit',
      `limit must be an integer from 1 to ${ROUTING_FORM_PAGE.max}`,
    )
  const organizationId = ctx.principal.organization.id
  const after = input.cursor === undefined ? undefined : decodeCursor(organizationId, input.cursor)
  return ctx.db.transaction().execute(async (trx) => {
    await authorize(trx, ctx, false)
    const rows = await selectForms(trx, organizationId)
      .$if(after !== undefined, (query) =>
        query.where(
          sql<boolean>`(f.created_at, f.id) < (${after?.created}::timestamptz, ${after?.id}::uuid)`,
        ),
      )
      .orderBy('f.created_at', 'desc')
      .orderBy('f.id', 'desc')
      .limit(limit + 1)
      .execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      data: page.map((row) => toSummary(row, storedDraft(row.draft))),
      nextCursor: rows.length > limit && last ? encodeCursor(organizationId, last) : null,
    }
  })
}

const UPDATE_FIELDS = ['expectedRevision', 'slug', 'enabled', ...DRAFT_FIELDS] as const

/**
 * Saves the given fields if the form is still at `expectedRevision`, and increments the
 * revision; a stale revision is refused with `routing_revision_conflict`. Draft fields replace
 * their stored values and the whole draft is validated again. Without a draft field (enabling,
 * disabling or a slug change) the stored draft stays as it is and is not validated again, so
 * that a stricter later validator can never block an urgent disable. Enabling needs a
 * published version; publication itself never changes `enabled`.
 */
export async function updateRoutingForm(
  ctx: ServiceContext,
  id: string,
  input: UpdateRoutingFormInput,
): Promise<RoutingForm> {
  requireScope(ctx, 'write')
  const fields = fieldsOf(input, UPDATE_FIELDS)
  const expected = validRevision(fields.expectedRevision)
  const slug = fields.slug === undefined ? undefined : validSlug(fields.slug)
  if (fields.enabled !== undefined && typeof fields.enabled !== 'boolean')
    throw invalidForm('enabled', 'must be true or false')
  const enabled = fields.enabled as boolean | undefined
  const organizationId = ctx.principal.organization.id
  return withWriteErrors(() =>
    ctx.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await ctx.authorizeOrganizationWrite?.(trx, organizationId)
        await authorize(trx, ctx, true)
        const form = await findForm(trx, organizationId, id, true)
        assertRevision(form, expected)
        const draft = DRAFT_FIELDS.some((key) => fields[key] !== undefined)
          ? validDraft(
              // An undefined field is not given; null (description only) removes the value.
              Object.fromEntries(
                DRAFT_FIELDS.map((key) => [
                  key,
                  fields[key] !== undefined ? fields[key] : storedDraft(form.draft)[key],
                ]),
              ),
            )
          : undefined
        if (enabled === true && form.published_version_id === null)
          throw new DomainError(
            'conflict',
            'routing_form_not_published',
            'Publish the routing form before enabling it',
          )
        await trx
          .updateTable('routing_forms')
          .set({
            ...(draft === undefined ? {} : { draft: jsonb(draft) }),
            draft_revision: form.draft_revision + 1,
            ...(slug === undefined ? {} : { slug }),
            ...(enabled === undefined ? {} : { enabled }),
          })
          .where('id', '=', form.id)
          .execute()
        return loadForm(trx, organizationId, form.id)
      }),
  )
}

/**
 * Archives the form if it is still at `expectedRevision`: it is disabled at once, leaves the
 * manager's list and accepts no further writes. Its versions, and its slug, are kept.
 */
export async function archiveRoutingForm(
  ctx: ServiceContext,
  id: string,
  input: RevisionInput,
): Promise<void> {
  requireScope(ctx, 'write')
  const expected = validRevision(fieldsOf(input, ['expectedRevision']).expectedRevision)
  const organizationId = ctx.principal.organization.id
  await ctx.db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      await ctx.authorizeOrganizationWrite?.(trx, organizationId)
      await authorize(trx, ctx, true)
      const form = await findForm(trx, organizationId, id, true)
      assertRevision(form, expected)
      await trx
        .updateTable('routing_forms')
        .set({
          archived_at: new Date(ctx.now().epochMilliseconds),
          enabled: false,
          draft_revision: form.draft_revision + 1,
        })
        .where('id', '=', form.id)
        .execute()
    })
}

// --- Publication ---------------------------------------------------------------------------

/** Each event target with its rule identity: the rules' in order, then the fallback's. */
function eventTargets(config: RoutingFormConfig): { ruleId: string; eventTypeId: string }[] {
  const targets: [string, RoutingTarget][] = config.rules.map((rule) => [rule.id, rule.target])
  targets.push([FALLBACK_RULE_ID, config.fallback])
  return targets.flatMap(([ruleId, target]) =>
    target.kind === 'event' ? [{ ruleId, eventTypeId: target.eventTypeId }] : [],
  )
}

/**
 * IDs keep one meaning for the life of a form (docs/routing-forms.md, "Form model and
 * limits"): a question keeps its type, an option its question, a rule stays a rule, and an ID
 * that a retained version used but the current published version no longer has is not
 * brought back. Checked against every retained version under the form lock.
 */
async function assertStableIdentities(trx: Db, form: FormRow, config: RoutingFormConfig) {
  const ids = [
    ...config.questions.flatMap((question) => [
      question.id,
      ...(question.type === 'select' ? question.options.map((option) => option.id) : []),
    ]),
    ...config.rules.map((rule) => rule.id),
  ]
  if (ids.length === 0) return
  const { rows } = await sql<{ id: string; identity: string; current: boolean | null }>`
    SELECT item.id, item.identity, bool_or(v.id = ${form.published_version_id}::uuid) AS current
    FROM routing_form_versions v
    CROSS JOIN LATERAL (
      SELECT q->>'id' AS id, 'question:' || (q->>'type') AS identity
        FROM jsonb_array_elements(v.questions) q
      UNION ALL
      SELECT o->>'id', 'option:' || (q->>'id')
        FROM jsonb_array_elements(v.questions) q
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE jsonb_typeof(q->'options') WHEN 'array' THEN q->'options' ELSE '[]'::jsonb END) o
      UNION ALL
      SELECT r->>'id', 'rule' FROM jsonb_array_elements(v.rules) r
    ) item
    WHERE v.organization_id = ${form.organization_id} AND v.form_id = ${form.id}
      AND item.id = ANY(${ids}::text[])
    GROUP BY item.id, item.identity`.execute(trx)
  const history = new Map<string, { identities: Set<string>; current: boolean }>()
  for (const row of rows) {
    const entry = history.get(row.id) ?? { identities: new Set<string>(), current: false }
    entry.identities.add(row.identity)
    entry.current ||= row.current === true
    history.set(row.id, entry)
  }
  const check = (id: string, identity: string, field: string) => {
    const seen = history.get(id)
    if (seen === undefined) return
    if (seen.identities.size !== 1 || !seen.identities.has(identity) || !seen.current)
      throw invalidForm(
        field,
        'must be a new ID: this form already used it for something else or removed it',
      )
  }
  for (const [i, question] of config.questions.entries()) {
    check(question.id, `question:${question.type}`, `questions.${i}.id`)
    if (question.type !== 'select') continue
    for (const [j, option] of question.options.entries())
      check(option.id, `option:${question.id}`, `questions.${i}.options.${j}.id`)
  }
  for (const [i, rule] of config.rules.entries()) check(rule.id, 'rule', `rules.${i}.id`)
}

/**
 * Publishes the draft at `expectedRevision` as the form's next immutable version and points
 * the form at it, in one transaction. Inside that transaction it rechecks the caller's current
 * membership, the draft, every event target's current eligibility and mapping compatibility
 * (group-mode and payment-requiring events included) and ID stability, and generates the
 * version's target dependencies. Concurrent publications of one revision have one winner;
 * the others get `routing_revision_conflict`. `enabled` is unchanged. With a `requestId`, a
 * retry returns the version the first request published, with the form as it is now, and
 * concurrent retries of one key wait for each other instead of conflicting.
 */
export async function publishRoutingForm(
  ctx: ServiceContext,
  id: string,
  input: PublishRoutingFormInput,
): Promise<{ form: RoutingForm; version: RoutingFormVersion }> {
  requireScope(ctx, 'write')
  const fields = fieldsOf(input, ['expectedRevision', 'requestId'])
  const expected = validRevision(fields.expectedRevision)
  const operation = operationOf(ctx, 'publish', validRequestId(fields.requestId), {
    formId: isUuid(id) ? id.toLowerCase() : id,
    expectedRevision: expected,
  })
  const organizationId = ctx.principal.organization.id
  return withWriteErrors(() =>
    ctx.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await ctx.authorizeOrganizationWrite?.(trx, organizationId)
        // The organization boundary first, so membership is current once it is granted.
        await authorize(trx, ctx, true)
        // Before any revision check: a successful first attempt has moved the revision on.
        if (operation) {
          const previous = await lockedOperation(trx, operation)
          if (previous)
            return {
              form: await loadForm(trx, organizationId, previous.form_id),
              version: await loadVersion(
                trx,
                organizationId,
                previous.form_id,
                previous.version_id as string,
              ),
            }
        }
        // Unlocked read: which event types to lock before the form.
        const unlocked = await findForm(trx, organizationId, id, false)
        assertRevision(unlocked, expected)
        const targets = eventTargets(validStoredConfig(unlocked.draft))
        await lockTargetEvents(
          trx,
          organizationId,
          targets.map((target) => target.eventTypeId),
        )
        const form = await findForm(trx, organizationId, id, true)
        // Every write increments the revision, so at this revision the draft is the one read
        // above and its event types are locked; a concurrent publication has moved it on.
        assertRevision(form, expected)
        const config = validStoredConfig(form.draft)
        const dependencies = eventTargets(config)
        validateRoutingTargets(
          organizationId,
          config,
          await loadRoutingTargetEvents(
            trx,
            dependencies.map((target) => target.eventTypeId),
          ),
        )
        await assertStableIdentities(trx, form, config)
        const publishedAt = new Date(ctx.now().epochMilliseconds)
        const version = await trx
          .insertInto('routing_form_versions')
          .values({
            organization_id: organizationId,
            form_id: form.id,
            version_number: form.last_version_number + 1,
            questions: jsonb(config.questions),
            rules: jsonb(config.rules),
            fallback: jsonb(config.fallback),
            published_at: publishedAt,
            published_by_user_id: ctx.principal.user.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        // Generated here from the published targets, fallback included; never caller input.
        if (dependencies.length > 0)
          await trx
            .insertInto('routing_target_dependencies')
            .values(
              dependencies.map((dependency) => ({
                organization_id: organizationId,
                version_id: version.id,
                rule_id: dependency.ruleId,
                event_type_id: dependency.eventTypeId,
                // Checked just above, under the event type locks.
                health_code: 'ok',
                health_checked_at: publishedAt,
              })),
            )
            .execute()
        if (operation) await recordOperation(trx, operation, form.id, version.id)
        await trx
          .updateTable('routing_forms')
          .set({ published_version_id: version.id, draft_revision: form.draft_revision + 1 })
          .where('id', '=', form.id)
          .execute()
        return {
          form: await loadForm(trx, organizationId, form.id),
          version: await loadVersion(trx, organizationId, form.id, version.id),
        }
      }),
  )
}

// --- Preview -------------------------------------------------------------------------------

/** Whether this rule alone matches, through the shared evaluator itself. */
const ruleMatches = (config: RoutingFormConfig, rule: RoutingRule, answers: RoutingAnswers) =>
  evaluateRoutingForm({ ...config, rules: [rule] }, answers).ruleId === rule.id

/**
 * Evaluates the current draft against `answers` with the shared validator and evaluator and
 * explains the outcome to the form's manager, including which event targets could not be
 * routed to now. Like routing at run time, it checks target eligibility, not answer mappings:
 * a mapping that no longer fits only drops its prefill then, and publication refuses it.
 * Runs in a read-only transaction: it stores no answers and creates no receipt, booking or
 * any other row, and takes no row lock.
 */
export async function previewRoutingForm(
  ctx: ServiceContext,
  id: string,
  input: PreviewRoutingFormInput,
): Promise<RoutingFormPreview> {
  requireScope(ctx, 'write')
  const fields = fieldsOf(input, ['answers'])
  const organizationId = ctx.principal.organization.id
  return ctx.db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      await authorize(trx, ctx, false)
      const form = await findForm(trx, organizationId, id, false)
      const config = validStoredConfig(form.draft)
      const answers = validateRoutingAnswers(config.questions, fields.answers)
      const match = evaluateRoutingForm(config, answers)
      const rules: RoutingPreviewRule[] = []
      for (const rule of config.rules) {
        rules.push({
          ruleId: rule.id,
          matched: ruleMatches(config, rule, answers),
          conditions: rule.conditions.map((condition) => ({
            questionId: condition.questionId,
            matched: ruleMatches(config, { ...rule, conditions: [condition] }, answers),
          })),
        })
        if (rule.id === match.ruleId) break
      }
      const candidates: [string, RoutingTarget][] = [[match.ruleId, match.target]]
      if (match.ruleId !== FALLBACK_RULE_ID) candidates.push([FALLBACK_RULE_ID, config.fallback])
      const events = await loadRoutingTargetEvents(
        trx,
        candidates.flatMap(([, target]) => (target.kind === 'event' ? [target.eventTypeId] : [])),
      )
      const unavailableTargets: RoutingFormPreview['unavailableTargets'] = []
      let resolved: [string, RoutingTarget] | undefined
      // A broken matched target goes straight to the fallback, never to a later rule.
      for (const [ruleId, target] of candidates) {
        const reason =
          target.kind === 'event'
            ? routingTargetProblem(organizationId, events.get(target.eventTypeId))
            : undefined
        if (reason === undefined) {
          resolved = [ruleId, target]
          break
        }
        unavailableTargets.push({ ruleId, reason })
      }
      return {
        draftRevision: form.draft_revision,
        matchedRuleId: match.ruleId,
        resolvedRuleId: resolved?.[0] ?? null,
        target: resolved?.[1] ?? null,
        unavailableTargets,
        rules,
      }
    })
}
