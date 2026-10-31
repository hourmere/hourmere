// Event types: what invitees can book. They belong to the organization the caller acts in.
// In a personal organization an event type is its user's (personal page /{handle}/{slug});
// in a team it belongs to the team page (owner_user_id NULL), readable by every member and
// managed by owners and admins. Deleting one only marks it deleted, so past bookings keep
// pointing at the event type they were made with.
import { requireActiveApiKey } from '@hourmere/auth'
import { validateEventTypeRules } from '@hourmere/core'
import type { Db, Json } from '@hourmere/db'
import { sql } from 'kysely'
import { LOCATION_KINDS } from './availability.ts'
import {
  type CatalogPage,
  type CatalogPageInput,
  catalogPage,
  checkedCatalogPage,
} from './catalog-page.ts'
import {
  automaticMeet,
  automaticZoom,
  eligibleMeetHosts,
  meetOrganizer,
  requireMeetDestination,
  requireZoomConnection,
} from './conferences.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { assertHosts, lockOrganization } from './hosts.ts'
import {
  engineValidation,
  isConstraintViolation,
  isUuid,
  jsonb,
  SQLSTATE,
  timestamp,
} from './internal.ts'
import { parseQuestions, type Question, validateQuestions } from './questions.ts'
import {
  type SuccessRedirect,
  type SuccessRedirectInput,
  type SuccessRedirectPolicy,
  validateSuccessRedirect,
} from './success-redirect.ts'
import { cleanText } from './text.ts'

/** Where the meeting happens. Meet and Zoom links are generated per booking. */
export type EventTypeLocation =
  | { kind: 'google_meet'; autoCreate?: true }
  | { kind: 'zoom'; autoCreate?: true }
  /** The host's number, in E.164 (`+14155550123`). */
  | { kind: 'phone'; number: string }
  | { kind: 'in_person'; address: string }
  /** Any other video or meeting link (http or https). */
  | { kind: 'link'; url: string }

/** A question as written by the caller (see questions.ts); `required` defaults to false. */
export type QuestionInput = Omit<Question, 'required'> & { required?: boolean | undefined }

export type SchedulingType = 'individual' | 'round_robin' | 'collective'

export interface EventType {
  id: string
  organizationId: string
  /** The user whose personal page lists it; null for a team event type. */
  ownerUserId: string | null
  slug: string
  title: string
  description: string | null
  durationMinutes: number
  /** Distinct permitted lengths; includes durationMinutes, the default. */
  allowedDurationsMinutes: number[]
  /** null = the selected duration. */
  slotStepMinutes: number | null
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minimumNoticeMinutes: number
  /** null = no limit. */
  bookingWindowDays: number | null
  /** null = no limit. */
  maxBookingsPerDay: number | null
  schedulingType: SchedulingType
  /** Round-robin booking requires a separate explicit activation action. */
  roundRobinActive: boolean
  /** Current configured hosts; at most eight. */
  hosts: { userId: string }[]
  zoomConnectionId?: string | null | undefined
  conferenceOrganizer: { userId: string } | null
  location: EventTypeLocation | null
  successRedirect: SuccessRedirect | null
  questions: Question[]
  isActive: boolean
  /** Hidden from public listings; the direct link remains bookable. */
  isHidden: boolean
  /** Whether new bookings may add guest recipients; existing attendees are preserved. */
  allowGuests: boolean
  position: number
  /** The host's schedule; null = the host's default schedule. */
  scheduleId: string | null
  createdAt: string
  updatedAt: string
}

export interface EventTypeInput {
  schedulingType?: SchedulingType | undefined
  hosts?: { userId: string }[] | undefined
  zoomConnectionId?: string | null | undefined
  conferenceOrganizer?: { userId: string } | null | undefined
  slug: string
  title: string
  description?: string | null | undefined
  durationMinutes: number
  /** Omitted on creation = [durationMinutes]. */
  allowedDurationsMinutes?: number[] | undefined
  slotStepMinutes?: number | null | undefined
  bufferBeforeMinutes?: number | undefined
  bufferAfterMinutes?: number | undefined
  minimumNoticeMinutes?: number | undefined
  bookingWindowDays?: number | null | undefined
  maxBookingsPerDay?: number | null | undefined
  location?: EventTypeLocation | null | undefined
  successRedirect?: SuccessRedirectInput | null | undefined
  questions?: QuestionInput[] | undefined
  isActive?: boolean | undefined
  isHidden?: boolean | undefined
  allowGuests?: boolean | undefined
  position?: number | undefined
  /** One of the host's schedules; null or omitted = the host's default schedule. */
  scheduleId?: string | null | undefined
}

/** Omitted fields stay as they are; null clears a nullable field. */
export type EventTypeUpdate = Partial<EventTypeInput>

/** Lowercase letters, digits and inner hyphens, 1–64 characters (the `event_types` CHECK). */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
/** E.164: a plus sign, then 7–15 digits. */
export const PHONE_NUMBER_PATTERN = /^\+[1-9][0-9]{6,14}$/

/**
 * Limits of the fields the availability engine does not read (its rules have their own;
 * questions have theirs in questions.ts).
 */
export const EVENT_TYPE_LIMITS = {
  slugMaxLength: 64,
  titleMaxLength: 200,
  descriptionMaxLength: 5000,
  addressMaxLength: 500,
  urlMaxLength: 2000,
  /** position is a Postgres integer. */
  positionMin: -2_147_483_648,
  positionMax: 2_147_483_647,
} as const

/** The columns a caller sets, validated and normalized. */
interface Fields {
  slug: string
  title: string
  description: string | null
  durationMinutes: number
  allowedDurationsMinutes: number[]
  slotStepMinutes: number | null
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minimumNoticeMinutes: number
  bookingWindowDays: number | null
  maxBookingsPerDay: number | null
  location: EventTypeLocation | null
  successRedirect: SuccessRedirect | null
  questions: Question[]
  isActive: boolean
  /** Hidden from public listings; the direct link remains bookable. */
  isHidden: boolean
  /** Whether new bookings may add guest recipients; existing attendees are preserved. */
  allowGuests: boolean
  position: number
}

const FIELD_NAMES = [
  'slug',
  'title',
  'description',
  'durationMinutes',
  'allowedDurationsMinutes',
  'slotStepMinutes',
  'bufferBeforeMinutes',
  'bufferAfterMinutes',
  'minimumNoticeMinutes',
  'bookingWindowDays',
  'maxBookingsPerDay',
  'location',
  'successRedirect',
  'questions',
  'isActive',
  'isHidden',
  'allowGuests',
  'position',
] as const satisfies readonly (keyof Fields)[]

const DEFAULTS = {
  description: null,
  slotStepMinutes: null,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minimumNoticeMinutes: 0,
  bookingWindowDays: null,
  maxBookingsPerDay: null,
  location: null,
  successRedirect: null,
  questions: [],
  isActive: true,
  isHidden: false,
  allowGuests: false,
  position: 0,
} as const satisfies Partial<Fields>

const notFound = () => new DomainError('not_found', 'event_type_not_found')

const insufficientRole = () =>
  new DomainError(
    'forbidden',
    'insufficient_role',
    "Only the organization's owners and admins can manage its event types",
  )

/** The event types the caller can see in the organization they act in, by position. */
export async function listEventTypes(ctx: ServiceContext): Promise<EventType[]> {
  const rows = await selectEventTypes(ctx.db)
    .where('e.organization_id', '=', ctx.principal.organization.id)
    .where('e.deleted_at', 'is', null)
    .where((eb) =>
      eb.or([eb('e.owner_user_id', 'is', null), eb('e.owner_user_id', '=', ctx.principal.user.id)]),
    )
    .orderBy('e.position')
    .orderBy('e.id')
    .execute()
  return rows.map(toEventType)
}

export async function getEventType(ctx: ServiceContext, id: string): Promise<EventType> {
  const row = await visibleRow(ctx.db, ctx, id)
  return toEventType(await loadEventType(ctx.db, row.id))
}

/** Compact metadata for discovery; details are read explicitly with getEventType. */
export type EventTypeSummary = Pick<
  EventType,
  | 'id'
  | 'organizationId'
  | 'ownerUserId'
  | 'slug'
  | 'title'
  | 'durationMinutes'
  | 'schedulingType'
  | 'isActive'
  | 'isHidden'
  | 'allowGuests'
  | 'position'
>

/** Visible configurations by id, with no description, location or question blobs in the list. */
export async function listEventTypeCatalog(
  ctx: ServiceContext,
  input: CatalogPageInput = {},
): Promise<CatalogPage<EventTypeSummary>> {
  const { limit, after } = checkedCatalogPage(input)
  let query = ctx.db
    .selectFrom('event_types')
    .select([
      'id',
      'organization_id',
      'owner_user_id',
      'slug',
      'title',
      'duration_minutes',
      'scheduling_type',
      'is_active',
      'is_hidden',
      'allow_guests',
      'position',
    ])
    .where('organization_id', '=', ctx.principal.organization.id)
    .where('deleted_at', 'is', null)
    .where((eb) =>
      eb.or([eb('owner_user_id', 'is', null), eb('owner_user_id', '=', ctx.principal.user.id)]),
    )
  if (after !== undefined) query = query.where('id', '>', after)
  const rows = await query
    .orderBy('id')
    .limit(limit + 1)
    .execute()
  return catalogPage(
    rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      ownerUserId: r.owner_user_id,
      slug: r.slug,
      title: r.title,
      durationMinutes: r.duration_minutes,
      schedulingType: r.scheduling_type as SchedulingType,
      isActive: r.is_active,
      isHidden: r.is_hidden,
      allowGuests: r.allow_guests,
      position: r.position,
    })),
    limit,
  )
}

/**
 * Creates an event type in the organization the caller acts in, hosted by the caller. In
 * a personal organization it goes on the caller's personal page; in a team, on the team
 * page, which needs the owner or admin role.
 */
export async function createEventType(
  ctx: ServiceContext,
  input: EventTypeInput,
): Promise<EventType> {
  const fields = validFields({ ...DEFAULTS, ...defined(input) }, ctx.successRedirectPolicy)
  return withWriteErrors(() =>
    ctx.db.transaction().execute(async (trx) => {
      await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id)
      await lockOrganization(trx, ctx.principal.organization.id)
      const { personalOwnerId, canManageTeam } = await access(trx, ctx, true)
      if (personalOwnerId !== null ? personalOwnerId !== ctx.principal.user.id : !canManageTeam) {
        throw insufficientRole()
      }
      const schedulingType = input.schedulingType ?? 'individual'
      const hostIds = validHosts(
        input.hosts ?? [{ userId: ctx.principal.user.id }],
        schedulingType,
        personalOwnerId,
      )
      const scheduleId = validScheduleId(input.scheduleId) ?? null
      if (schedulingType !== 'individual' && scheduleId !== null) throw invalidScheduleId()
      await assertHosts(trx, ctx.principal.organization.id, hostIds, true)
      const organizer = validOrganizer(input.conferenceOrganizer) ?? null,
        zoomConnection = validZoomConnection(input.zoomConnectionId) ?? null
      if (zoomConnection && !automaticZoom(fields.location))
        throw new DomainError('invalid', 'invalid_zoom_connection')
      await validateConference(
        trx,
        ctx,
        fields.location,
        schedulingType,
        hostIds,
        organizer,
        undefined,
        zoomConnection,
      )

      const { id } = await trx
        .insertInto('event_types')
        .values({
          ...columns(fields),
          organization_id: ctx.principal.organization.id,
          owner_user_id: personalOwnerId,
          scheduling_type: schedulingType,
          conference_organizer_user_id: organizer,
          zoom_connection_id: zoomConnection,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('event_type_hosts')
        .values(
          hostIds.map((user_id) => ({
            event_type_id: id,
            user_id,
            schedule_id: scheduleId,
          })),
        )
        .execute()
      return toEventType(await loadEventType(trx, id))
    }),
  )
}

/** Changes the given fields; see EventTypeUpdate. */
export async function updateEventType(
  ctx: ServiceContext,
  id: string,
  input: EventTypeUpdate,
): Promise<EventType> {
  const changes = defined(input)
  return withWriteErrors(() =>
    ctx.db.transaction().execute(async (trx) => {
      await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, id)
      await lockOrganization(trx, ctx.principal.organization.id)
      // Locked, so concurrent updates of different fields cannot undo each other.
      const row = await visibleRow(trx, ctx, id, { lock: true })
      await assertCanWrite(trx, ctx, row, true)
      const changingHosts = input.hosts !== undefined || input.schedulingType !== undefined
      if (
        input.schedulingType !== undefined &&
        input.schedulingType !== row.scheduling_type &&
        input.hosts === undefined
      ) {
        throw invalidHosts('Changing schedulingType requires the complete hosts list')
      }
      const schedulingType = input.schedulingType ?? row.scheduling_type
      const existing = await trx
        .selectFrom('event_type_hosts')
        .select(['user_id', 'schedule_id'])
        .where('event_type_id', '=', row.id)
        .orderBy('user_id')
        .execute()
      const scheduleId = validScheduleId(input.scheduleId)
      let hostIds: string[] | undefined
      if (changingHosts) {
        hostIds = validHosts(
          input.hosts ?? existing.map((h) => ({ userId: h.user_id })),
          schedulingType,
          row.owner_user_id,
        )
        await assertHosts(trx, row.organization_id, hostIds, true)
      }
      if (schedulingType !== 'individual' && scheduleId != null) throw invalidScheduleId()
      const organizer = validOrganizer(input.conferenceOrganizer),
        zoomConnection = validZoomConnection(input.zoomConnectionId)
      if (
        Object.keys(changes).length > 0 ||
        scheduleId !== undefined ||
        changingHosts ||
        organizer !== undefined ||
        zoomConnection !== undefined
      ) {
        const fields = validFields(
          {
            ...fieldsOf(row),
            ...changes,
            // A legacy duration-only edit keeps a single-duration type single-duration.
            ...(changes.durationMinutes !== undefined &&
            changes.allowedDurationsMinutes === undefined &&
            row.allowed_durations_minutes.length === 1
              ? { allowedDurationsMinutes: [changes.durationMinutes] }
              : {}),
          },
          ctx.successRedirectPolicy,
          input.successRedirect !== undefined,
        )
        if (
          zoomConnection &&
          zoomConnection !== row.zoom_connection_id &&
          !automaticZoom(fields.location)
        )
          throw new DomainError('invalid', 'invalid_zoom_connection')
        if (
          input.location !== undefined ||
          changingHosts ||
          scheduleId !== undefined ||
          organizer !== undefined ||
          zoomConnection !== undefined ||
          (input.isActive === true && !row.is_active)
        ) {
          const configuredHosts = hostIds ?? existing.map((h) => h.user_id)
          await assertHosts(trx, row.organization_id, configuredHosts, true)
          await validateConference(
            trx,
            ctx,
            fields.location,
            schedulingType,
            configuredHosts,
            organizer === undefined ? row.conference_organizer_user_id : organizer,
            row.id,
            zoomConnection === undefined ? row.zoom_connection_id : zoomConnection,
            !automaticZoom(row.location) ||
              schedulingType !== row.scheduling_type ||
              [...configuredHosts].sort().join() !==
                existing
                  .map((h) => h.user_id)
                  .sort()
                  .join() ||
              (zoomConnection !== undefined && zoomConnection !== row.zoom_connection_id) ||
              (input.isActive === true && !row.is_active),
          )
        }
        await trx
          .updateTable('event_types')
          .set({
            ...columns(fields),
            scheduling_type: schedulingType,
            ...(organizer !== undefined ? { conference_organizer_user_id: organizer } : {}),
            ...(zoomConnection !== undefined ? { zoom_connection_id: zoomConnection } : {}),
          })
          .where('id', '=', row.id)
          .execute()
      }
      if (hostIds) {
        const resolvedSchedule =
          schedulingType !== 'individual'
            ? null
            : scheduleId !== undefined
              ? scheduleId
              : existing.length === 1 && existing[0]?.user_id === hostIds[0]
                ? (existing[0]?.schedule_id ?? null)
                : null
        await trx
          .deleteFrom('event_type_hosts')
          .where('event_type_id', '=', row.id)
          .where('user_id', 'not in', hostIds)
          .execute()
        await trx
          .insertInto('event_type_hosts')
          .values(
            hostIds.map((user_id) => ({
              event_type_id: row.id,
              user_id,
              schedule_id: resolvedSchedule,
            })),
          )
          .onConflict((conflict) =>
            conflict
              .columns(['event_type_id', 'user_id'])
              .doUpdateSet({ schedule_id: resolvedSchedule }),
          )
          .execute()
      } else if (scheduleId !== undefined) {
        await trx
          .updateTable('event_type_hosts')
          .set({ schedule_id: scheduleId })
          .where('event_type_id', '=', row.id)
          .execute()
      }
      if (input.schedulingType !== undefined && input.schedulingType !== row.scheduling_type) {
        // Preserve the sequence and all surviving host rows; switching back needs Activate.
        await trx
          .updateTable('round_robin_state')
          .set({ enabled: false })
          .where('event_type_id', '=', row.id)
          .execute()
      }
      return toEventType(await loadEventType(trx, row.id))
    }),
  )
}

/** Marks the event type deleted; its slug becomes free and its bookings keep it. */
export async function deleteEventType(ctx: ServiceContext, id: string): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, id)
    await lockOrganization(trx, ctx.principal.organization.id)
    const row = await visibleRow(trx, ctx, id, { lock: true })
    await assertCanWrite(trx, ctx, row, true)
    await trx
      .updateTable('event_types')
      .set({ deleted_at: new Date(ctx.now().epochMilliseconds) })
      .where('id', '=', row.id)
      .where('deleted_at', 'is', null)
      .execute()
  })
}

function selectEventTypes(db: Db) {
  return db
    .selectFrom('event_types as e')
    .selectAll('e')
    .select(
      sql<boolean>`coalesce((SELECT r.enabled FROM round_robin_state r WHERE r.event_type_id=e.id),false)`.as(
        'round_robin_active',
      ),
    )
    .select(
      sql<
        { userId: string }[]
      >`(SELECT coalesce(jsonb_agg(host), '[]'::jsonb) FROM (SELECT h.user_id AS "userId" FROM event_type_hosts h WHERE h.event_type_id = e.id ORDER BY h.user_id LIMIT 8) host)`.as(
        'hosts',
      ),
    )
    .select((eb) =>
      eb
        .selectFrom('event_type_hosts as h')
        .select('h.schedule_id')
        .whereRef('h.event_type_id', '=', 'e.id')
        .orderBy('h.user_id')
        .limit(1)
        .as('schedule_id'),
    )
}

type EventTypeRow = Awaited<
  ReturnType<ReturnType<typeof selectEventTypes>['executeTakeFirstOrThrow']>
>

async function loadEventType(db: Db, id: string): Promise<EventTypeRow> {
  return selectEventTypes(db).where('e.id', '=', id).executeTakeFirstOrThrow()
}

/**
 * A live event type of the caller's organization that the caller may see: team event types
 * are visible to every member, personal ones only to their owner. Anything else is as good
 * as missing.
 */
async function visibleRow(db: Db, ctx: ServiceContext, id: string, { lock = false } = {}) {
  if (!isUuid(id)) throw notFound()
  let query = db
    .selectFrom('event_types')
    .selectAll()
    .where('id', '=', id)
    .where('organization_id', '=', ctx.principal.organization.id)
    .where('deleted_at', 'is', null)
  if (lock) query = query.forUpdate()
  const row = await query.executeTakeFirst()
  if (!row || (row.owner_user_id !== null && row.owner_user_id !== ctx.principal.user.id)) {
    throw notFound()
  }
  return row
}

/** A visible personal event type is the caller's own; a team one needs owner or admin. */
async function assertCanWrite(
  db: Db,
  ctx: ServiceContext,
  row: { owner_user_id: string | null },
  lock = false,
) {
  if (row.owner_user_id !== null) return
  if (!(await access(db, ctx, lock)).canManageTeam) throw insufficientRole()
}

/** The caller's standing in the organization they act in. */
async function access(db: Db, ctx: ServiceContext, lock = false) {
  // User before member, matching auth.user deletion's membership cascade.
  if (lock) {
    const actor = await db
      .selectFrom('auth.user')
      .select('emailVerified')
      .where('id', '=', ctx.principal.user.id)
      .forShare()
      .executeTakeFirst()
    if (!actor?.emailVerified) return { personalOwnerId: null, canManageTeam: false }
  }
  let query = db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .where('u.emailVerified', '=', true)
    .leftJoin('personal_organizations as p', 'p.organization_id', 'm.organizationId')
    .select(['m.role', 'p.user_id as personalOwnerId'])
    .where('m.userId', '=', ctx.principal.user.id)
    .where('m.organizationId', '=', ctx.principal.organization.id)
  if (lock) query = query.forShare('m')
  const row = await query.executeTakeFirst()
  // Better Auth stores several roles comma-separated.
  const roles = row?.role.split(',').map((role) => role.trim()) ?? []
  return {
    personalOwnerId: row?.personalOwnerId ?? null,
    canManageTeam: roles.includes('owner') || roles.includes('admin'),
  }
}

/** Maps constraint violations of event type writes to the caller's mistake. */
async function withWriteErrors<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    const unique = SQLSTATE.uniqueViolation
    if (
      isConstraintViolation(error, unique, 'event_types_personal_slug') ||
      isConstraintViolation(error, unique, 'event_types_team_slug')
    ) {
      throw new DomainError(
        'conflict',
        'slug_taken',
        'Another event type on this page already uses this slug',
        { cause: error },
      )
    }
    if (
      isConstraintViolation(
        error,
        SQLSTATE.foreignKeyViolation,
        'event_type_hosts_schedule_id_user_id_fkey',
      )
    ) {
      throw invalidScheduleId({ cause: error })
    }
    throw error
  }
}

/** The fields of `input` that are set, so they can be laid over defaults or current values. */
function defined(input: EventTypeUpdate): Partial<Record<keyof Fields, unknown>> {
  const result: Partial<Record<keyof Fields, unknown>> = {}
  for (const name of FIELD_NAMES) if (input[name] !== undefined) result[name] = input[name]
  return result
}

const invalid = (message: string) => new DomainError('invalid', 'invalid_event_type', message)

function validFields(
  candidate: Partial<Record<keyof Fields, unknown>>,
  policy?: SuccessRedirectPolicy,
  validateRedirect = true,
): Fields {
  const c = candidate
  const allowedDurationsMinutes =
    c.allowedDurationsMinutes === undefined ? [c.durationMinutes] : c.allowedDurationsMinutes
  // The engine's own check, so a stored event type can never make availability fail.
  engineValidation('invalid_event_type', () =>
    validateEventTypeRules(
      {
        durationMinutes: c.durationMinutes,
        allowedDurationsMinutes,
        slotStepMinutes: c.slotStepMinutes ?? undefined,
        bufferBeforeMinutes: c.bufferBeforeMinutes,
        bufferAfterMinutes: c.bufferAfterMinutes,
        minimumNoticeMinutes: c.minimumNoticeMinutes,
        bookingWindowDays: c.bookingWindowDays ?? undefined,
        maxBookingsPerDay: c.maxBookingsPerDay ?? undefined,
      },
      '',
    ),
  )
  if (typeof c.isActive !== 'boolean') throw invalid('isActive must be true or false')
  if (typeof c.isHidden !== 'boolean') throw invalid('isHidden must be true or false')
  if (typeof c.allowGuests !== 'boolean') throw invalid('allowGuests must be true or false')
  const { positionMin, positionMax } = EVENT_TYPE_LIMITS
  if (
    !Number.isSafeInteger(c.position) ||
    (c.position as number) < positionMin ||
    (c.position as number) > positionMax
  ) {
    throw invalid(`position must be a whole number from ${positionMin} to ${positionMax}`)
  }
  return {
    slug: validSlug(c.slug),
    title: validTitle(c.title),
    description: validDescription(c.description),
    durationMinutes: c.durationMinutes as number,
    allowedDurationsMinutes: [...(allowedDurationsMinutes as number[])],
    slotStepMinutes: (c.slotStepMinutes ?? null) as number | null,
    bufferBeforeMinutes: c.bufferBeforeMinutes as number,
    bufferAfterMinutes: c.bufferAfterMinutes as number,
    minimumNoticeMinutes: c.minimumNoticeMinutes as number,
    bookingWindowDays: (c.bookingWindowDays ?? null) as number | null,
    maxBookingsPerDay: (c.maxBookingsPerDay ?? null) as number | null,
    location: validLocation(c.location),
    // A policy change must not block unrelated edits. Only an explicitly supplied
    // redirect needs current-policy validation; otherwise preserve the saved value.
    successRedirect: validateRedirect
      ? validateSuccessRedirect(c.successRedirect, policy)
      : (c.successRedirect as SuccessRedirect | null),
    questions: validateQuestions(c.questions),
    isActive: c.isActive,
    isHidden: c.isHidden,
    allowGuests: c.allowGuests,
    position: c.position as number,
  }
}

function validSlug(value: unknown): string {
  if (typeof value !== 'string' || !SLUG_PATTERN.test(value)) {
    throw new DomainError(
      'invalid',
      'invalid_slug',
      'slug must be 1–64 lowercase letters, digits or hyphens, and start and end with a letter or digit',
    )
  }
  return value
}

/** One line of text (see text.ts). */
function validTitle(value: unknown): string {
  const max = EVENT_TYPE_LIMITS.titleMaxLength
  const title = cleanText(value, { max })
  if (title === undefined) {
    throw invalid(`title must be one line of 1–${max} characters without control characters`)
  }
  return title
}

/** Text that may span lines (see text.ts); blank means none. */
function validDescription(value: unknown): string | null {
  if (value === null || (typeof value === 'string' && value.trim() === '')) return null
  const max = EVENT_TYPE_LIMITS.descriptionMaxLength
  const description = cleanText(value, { multiline: true, max })
  if (description === undefined) {
    throw invalid(
      `description must be text of at most ${max} characters without control characters other than tabs and line breaks, or null`,
    )
  }
  return description
}

/**
 * A `scheduleId` in the body that is not one of the host's schedules. Not
 * `schedule_not_found`, which is the 404 for a schedule named in the path.
 */
const invalidScheduleId = (options?: { cause?: unknown }) =>
  new DomainError(
    'invalid',
    'invalid_schedule_id',
    "scheduleId must be one of the host's schedules",
    options,
  )

function validScheduleId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value
  if (!isUuid(value)) throw invalidScheduleId()
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `value` has only these keys, so a misspelled field is reported, not dropped. */
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key))

function validLocation(value: unknown): EventTypeLocation | null {
  if (value === null) return null
  const fail = (message: string): never => {
    throw new DomainError('invalid', 'invalid_location', message)
  }
  if (!isPlainObject(value)) return fail('location must be an object with a kind, or null')
  const { kind } = value
  const expect = (keys: readonly string[]) => {
    if (!onlyKeys(value, ['kind', ...keys])) {
      fail(
        `A ${kind} location has ${keys.length ? `only kind and ${keys.join(', ')}` : 'only a kind'}`,
      )
    }
  }
  switch (kind) {
    case 'google_meet':
    case 'zoom':
      expect(['autoCreate'])
      if (value.autoCreate !== undefined && value.autoCreate !== true)
        return fail('autoCreate must be true when specified')
      return value.autoCreate === true ? { kind, autoCreate: true } : { kind }
    case 'phone': {
      expect(['number'])
      const { number } = value
      if (typeof number !== 'string' || !PHONE_NUMBER_PATTERN.test(number)) {
        return fail('location.number must be a phone number in E.164 format, e.g. +14155550123')
      }
      return { kind, number }
    }
    case 'in_person': {
      expect(['address'])
      const max = EVENT_TYPE_LIMITS.addressMaxLength
      const address = cleanText(value.address, { max })
      if (address === undefined) {
        return fail(
          `location.address must be one line of 1–${max} characters without control characters`,
        )
      }
      return { kind, address }
    }
    case 'link': {
      expect(['url'])
      const max = EVENT_TYPE_LIMITS.urlMaxLength
      // Checked as given, like other text (the parser would silently drop tabs and line
      // breaks), then stored in its parsed, normalized form.
      const given = cleanText(value.url, { max })
      const href = given !== undefined && URL.canParse(given) ? new URL(given) : undefined
      if (!href || !['http:', 'https:'].includes(href.protocol) || href.href.length > max) {
        return fail(
          `location.url must be an http or https URL of at most ${max} characters without control characters`,
        )
      }
      return { kind, url: href.href }
    }
    default:
      return fail(`location.kind must be one of ${LOCATION_KINDS.join(', ')}`)
  }
}

function fieldsOf(row: {
  slug: string
  title: string
  description: string | null
  duration_minutes: number
  allowed_durations_minutes: number[]
  slot_step_minutes: number | null
  buffer_before_minutes: number
  buffer_after_minutes: number
  minimum_notice_minutes: number
  booking_window_days: number | null
  max_bookings_per_day: number | null
  location: Json | null
  success_redirect: Json | null
  questions: Json
  is_active: boolean
  is_hidden: boolean
  allow_guests: boolean
  position: number
}): Fields {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    durationMinutes: row.duration_minutes,
    allowedDurationsMinutes: row.allowed_durations_minutes,
    slotStepMinutes: row.slot_step_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes,
    minimumNoticeMinutes: row.minimum_notice_minutes,
    bookingWindowDays: row.booking_window_days,
    maxBookingsPerDay: row.max_bookings_per_day,
    location: row.location as EventTypeLocation | null,
    successRedirect: row.success_redirect as unknown as SuccessRedirect | null,
    questions: parseQuestions(row.questions),
    isActive: row.is_active,
    isHidden: row.is_hidden,
    allowGuests: row.allow_guests,
    position: row.position,
  }
}

function columns(fields: Fields) {
  return {
    slug: fields.slug,
    title: fields.title,
    description: fields.description,
    duration_minutes: fields.durationMinutes,
    allowed_durations_minutes: fields.allowedDurationsMinutes,
    slot_step_minutes: fields.slotStepMinutes,
    buffer_before_minutes: fields.bufferBeforeMinutes,
    buffer_after_minutes: fields.bufferAfterMinutes,
    minimum_notice_minutes: fields.minimumNoticeMinutes,
    booking_window_days: fields.bookingWindowDays,
    max_bookings_per_day: fields.maxBookingsPerDay,
    location: fields.location === null ? null : jsonb(fields.location),
    success_redirect: fields.successRedirect === null ? null : jsonb(fields.successRedirect),
    questions: jsonb(fields.questions),
    is_active: fields.isActive,
    is_hidden: fields.isHidden,
    allow_guests: fields.allowGuests,
    position: fields.position,
  }
}

function toEventType(row: EventTypeRow): EventType {
  return {
    id: row.id,
    organizationId: row.organization_id,
    ownerUserId: row.owner_user_id,
    ...fieldsOf(row),
    schedulingType: row.scheduling_type as SchedulingType,
    roundRobinActive: row.scheduling_type === 'round_robin' && row.round_robin_active,
    hosts: row.hosts,
    ...(row.zoom_connection_id ? { zoomConnectionId: row.zoom_connection_id } : {}),
    conferenceOrganizer: row.conference_organizer_user_id
      ? { userId: row.conference_organizer_user_id }
      : null,
    scheduleId: row.schedule_id,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}

const invalidHosts = (
  message = 'hosts must name distinct current verified members: one individual host or two to eight collective hosts',
) => new DomainError('invalid', 'invalid_hosts', message)

function validHosts(value: unknown, mode: string, personalOwnerId: string | null): string[] {
  if (mode !== 'individual' && mode !== 'collective' && mode !== 'round_robin')
    throw invalidHosts('This scheduling mode cannot be configured')
  if (
    !Array.isArray(value) ||
    value.length < (mode === 'collective' ? 2 : 1) ||
    value.length > (mode === 'individual' ? 1 : 8)
  )
    throw invalidHosts()
  const ids: string[] = []
  for (const host of value) {
    if (!isPlainObject(host) || !onlyKeys(host, ['userId']) || !isUuid(host.userId))
      throw invalidHosts()
    ids.push((host.userId as string).toLowerCase())
  }
  if (new Set(ids).size !== ids.length) throw invalidHosts()
  if (personalOwnerId !== null && (mode !== 'individual' || ids[0] !== personalOwnerId))
    throw invalidHosts('Personal event types must be hosted by their owner')
  return ids.sort()
}

/** Host assignment exposes names and stable member/user IDs to current owners/admins. */
export async function listEventTypeHosts(
  ctx: ServiceContext,
  input: CatalogPageInput = {},
): Promise<CatalogPage<{ id: string; memberId: string; name: string }>> {
  const { personalOwnerId, canManageTeam } = await access(ctx.db, ctx)
  if (personalOwnerId !== ctx.principal.user.id && !canManageTeam) throw insufficientRole()
  const { limit, after } = checkedCatalogPage(input)
  let query = ctx.db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .select(['u.id', 'm.id as memberId', 'u.name'])
    .where('m.organizationId', '=', ctx.principal.organization.id)
    .where('u.emailVerified', '=', true)
  if (after !== undefined) query = query.where('u.id', '>', after)
  return catalogPage(
    await query
      .orderBy('u.id')
      .limit(limit + 1)
      .execute(),
    limit,
  )
}

/** Explicit activation; metadata saves and mode changes never invoke this operation. */
export async function activateRoundRobin(ctx: ServiceContext, id: string): Promise<EventType> {
  return ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, id)
    await lockOrganization(trx, ctx.principal.organization.id)
    const row = await visibleRow(trx, ctx, id, { lock: true })
    await assertCanWrite(trx, ctx, row, true)
    if (row.owner_user_id !== null || row.scheduling_type !== 'round_robin')
      throw invalidHosts('Only team round-robin configurations can be activated')
    const hosts = await trx
      .selectFrom('event_type_hosts')
      .select(['user_id', 'schedule_id'])
      .where('event_type_id', '=', row.id)
      .orderBy('user_id')
      .execute()
    const ids = validHosts(
      hosts.map((host) => ({ userId: host.user_id })),
      'round_robin',
      null,
    )
    if (hosts.some((host) => host.schedule_id !== null)) throw invalidScheduleId()
    await assertHosts(trx, row.organization_id, ids, true)
    await trx
      .insertInto('round_robin_state')
      .values({ event_type_id: row.id, enabled: true })
      .onConflict((conflict) => conflict.column('event_type_id').doUpdateSet({ enabled: true }))
      .execute()
    return toEventType(await loadEventType(trx, row.id))
  })
}

function validOrganizer(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value
  if (!isPlainObject(value) || !onlyKeys(value, ['userId']) || !isUuid(value.userId))
    throw new DomainError('invalid', 'invalid_conference_organizer')
  return (value.userId as string).toLowerCase()
}
function validZoomConnection(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value
  if (!isUuid(value))
    throw new DomainError('invalid', 'invalid_zoom_connection', 'Choose your own Zoom connection.')
  return (value as string).toLowerCase()
}
async function validateConference(
  db: Db,
  ctx: ServiceContext,
  location: unknown,
  mode: string,
  hosts: string[],
  selected: string | null,
  eventTypeId?: string,
  zoomConnectionId?: string | null,
  authorizeZoom = true,
) {
  if (selected !== null && (mode !== 'collective' || !hosts.includes(selected)))
    throw new DomainError(
      'invalid',
      'invalid_conference_organizer',
      'Choose an organizer from the required hosts.',
    )
  if (automaticZoom(location)) {
    if (mode !== 'individual' || hosts.length !== 1)
      throw new DomainError(
        'invalid',
        'automatic_zoom_host_policy',
        'Automatic Zoom requires one explicitly authorized host.',
      )
    if (authorizeZoom) {
      if (hosts[0] !== ctx.principal.user.id)
        throw new DomainError(
          'forbidden',
          'zoom_host_session_required',
          'Only the host can choose their Zoom connection.',
        )
      if (ctx.principal.kind === 'session') {
        const session = await db
          .selectFrom('auth.session')
          .select('id')
          .where('id', '=', ctx.principal.sessionId)
          .where('userId', '=', ctx.principal.user.id)
          .where('expiresAt', '>', new Date(ctx.now().epochMilliseconds))
          .forShare()
          .executeTakeFirst()
        if (!session)
          throw new DomainError(
            'forbidden',
            'zoom_host_session_required',
            'Sign in again before choosing a private Zoom connection.',
          )
      }
      if (ctx.principal.kind === 'api_key')
        await requireActiveApiKey(db, ctx.principal, () => ctx.now().epochMilliseconds)
      await requireZoomConnection(db, hosts[0] as string, zoomConnectionId, ctx.automaticZoom)
    }
    return
  }
  if (!automaticMeet(location)) return
  if (mode === 'round_robin') await eligibleMeetHosts(db, hosts, eventTypeId, ctx.automaticMeet)
  else
    await requireMeetDestination(
      db,
      meetOrganizer(mode, hosts, selected) as string,
      eventTypeId,
      ctx.automaticMeet,
    )
}
