import type pg from 'pg'
import { fingerprint, type ImportPlan, parseImportPlan } from './plan.ts'
import { extractSource } from './source.ts'
import {
  assertAuthorization,
  type EntityKind,
  entityState,
  type ImportAuthorization,
  parserContext,
  readTargetIdentities,
  readTargetState,
  TargetRefusal,
  type TargetState,
  targetUsers,
} from './target.ts'
import type { BookingDecision, SourceSnapshot, SourceVersion } from './types.ts'
import { UUID, validInstant } from './users.ts'

export interface PreviewOptions {
  sourceId: string
  sourceVersion: SourceVersion
  selectedUserIds: number[]
  utcTimestampsConfirmed: true
  authorization: ImportAuthorization
  bookingDecisions: BookingDecision[]
  resolutions?: { handles?: Record<string, string>; slugs?: Record<string, string> }
  exclusions?: { events?: number[]; bookings?: number[]; schedules?: number[]; acknowledged: true }
}
export interface SourceInput extends PreviewOptions {
  connectionString: string
}
export type Disposition =
  | 'create'
  | 'match'
  | 'noop'
  | 'conflict'
  | 'block'
  | 'excluded'
  | 'warning'
export interface PreviewEntity {
  kind: EntityKind
  sourceKey: string
  sourceUserId: number
  targetId: string | null
  disposition: Disposition
  reason: string
  sourceFingerprint: string
}
export interface PreviewPlan {
  formatVersion: 1
  sourceId: string
  options: PreviewOptions
  sourceFingerprint: string
  targetFingerprint: string
  schemaFingerprint: string
  targetVersionFingerprint: string
  cutoff: string
  extractedAt: string
  plan: ImportPlan
  entities: PreviewEntity[]
  counts: { entity: string; disposition: Disposition; reason: string; count: number }[]
  addresses: {
    kind: 'handle' | 'slug'
    sourceId: number
    old: string
    proposed: string
    action: string
  }[]
  identities: {
    sourceId: number
    email: string | null
    targetIds: string[]
    authorizedTargetId: string | null
  }[]
  bookingTimes: {
    sourceId: number
    startUtc: string
    endUtc: string
    startLocal: string
    endLocal: string
    disposition: string
  }[]
  impacts: {
    code: string
    sourceBookingId: number
    relatedId: string | number
    count?: number
    limit?: number
  }[]
  writes: { table: string; rows: number }[]
  losses: ImportPlan['problems']
  inactiveEventSourceIds: number[]
  manualExclusions: { table: string; sourceId: number }[]
  reconnectProviders: ['calendar', 'conference']
  externalEffects: {
    mail: 0
    ics: 0
    calendar: 0
    conference: 0
    webhook: 0
    reminder: 0
    repairJob: 0
  }
  blocked: boolean
  planFingerprint: string
}
export function entityKey(kind: EntityKind, sourceKey: string): string {
  return `${kind}:${sourceKey}`
}
export function projectedTargetWithinLimits(
  state: TargetState,
  entities: PreviewEntity[],
  plan: ImportPlan,
): boolean {
  const creates = (kind: EntityKind) =>
    entities.filter((e) => e.kind === kind && e.disposition === 'create').length
  const additions = entities.filter(
    (e) => e.disposition === 'create' || e.disposition === 'match',
  ).length
  return (
    state.handles.length + creates('profile') <= 10_000 &&
    state.schedules.length + creates('schedule') <= 10_000 &&
    state.events.length + creates('event_type') <= 10_000 &&
    state.bookings.length + creates('booking') <= 10_000 &&
    state.items.length + additions <= 50_050 &&
    Buffer.byteLength(JSON.stringify(state)) +
      (additions ? Buffer.byteLength(JSON.stringify(plan)) + additions * 1024 : 0) <=
      32 * 1024 * 1024
  )
}

/** Register once per real source instance. Preview itself never creates even metadata. */
export async function registerImportSource(
  pool: pg.Pool,
  snapshot: SourceSnapshot,
  authorization: ImportAuthorization,
): Promise<string> {
  const operator = await pool.query('SELECT id FROM auth."user" WHERE id=$1 AND "emailVerified"', [
    authorization.operatorUserId,
  ])
  if (authorization.operatorAuthorized !== true || operator.rowCount !== 1)
    throw new TargetRefusal('IMPORT_AUTHORIZATION_REQUIRED')
  const result = await pool.query<{ id: string }>(
    `INSERT INTO import_sources
    (schema_fingerprint,source_version,created_by_user_id) VALUES($1,$2,$3) RETURNING id`,
    [snapshot.schemaFingerprint, snapshot.sourceVersion, authorization.operatorUserId],
  )
  return result.rows[0]?.id as string
}
export async function extractForPreview(
  pool: pg.Pool,
  input: SourceInput,
  cutoff: string,
): Promise<SourceSnapshot> {
  const identities = await readTargetIdentities(pool, input.authorization)
  return extractSource({
    connectionString: input.connectionString,
    sourceVersion: input.sourceVersion,
    selectedUserIds: input.selectedUserIds,
    utcTimestampsConfirmed: input.utcTimestampsConfirmed,
    cutoff,
    targetUsers: targetUsers(identities, input.authorization),
  })
}
export async function previewImport(pool: pg.Pool, input: SourceInput): Promise<PreviewPlan> {
  const cutoff = Temporal.Now.instant().toString({ smallestUnit: 'millisecond' })
  const snapshot = await extractForPreview(pool, input, cutoff)
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const state = await readTargetState(client, input.sourceId, input.authorization, cutoff)
    const { connectionString: _connectionString, ...options } = input
    const preview = buildPreview(snapshot, state, options)
    await client.query('COMMIT')
    return preview
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
export function buildPreview(
  snapshot: SourceSnapshot,
  state: TargetState,
  options: PreviewOptions,
): PreviewPlan {
  if (
    !UUID.test(options.sourceId) ||
    options.sourceId !== state.source.id ||
    options.sourceVersion !== snapshot.sourceVersion ||
    fingerprint(options.selectedUserIds) !== fingerprint(snapshot.selectedUserIds)
  )
    throw new TargetRefusal('IMPORT_SELECTION_CHANGED')
  assertAuthorization(state, options.authorization, snapshot)
  if (
    state.source.schema_fingerprint !== snapshot.schemaFingerprint ||
    state.source.source_version !== snapshot.sourceVersion
  )
    throw new TargetRefusal('IMPORT_SCHEMA_CHANGED')
  const effective = structuredClone(snapshot)
  const manualExclusions: PreviewPlan['manualExclusions'] = []
  if (options.exclusions) {
    if (options.exclusions.acknowledged !== true)
      throw new TargetRefusal('IMPORT_RESOLUTION_INVALID')
    for (const [key, table] of [
      ['events', 'EventType'],
      ['bookings', 'Booking'],
      ['schedules', 'Schedule'],
    ] as const) {
      const ids = options.exclusions[key] ?? []
      if (
        !Array.isArray(ids) ||
        ids.length > 10_000 ||
        new Set(ids).size !== ids.length ||
        ids.some(
          (id) =>
            !Number.isSafeInteger(id) ||
            !(snapshot.tables[table] ?? []).some((row) => row.id === id),
        )
      )
        throw new TargetRefusal('IMPORT_RESOLUTION_INVALID')
      effective.tables[table] = (effective.tables[table] ?? []).filter(
        (row) => !ids.includes(row.id as number),
      )
      manualExclusions.push(...ids.map((sourceId) => ({ table, sourceId })))
    }
  }
  // Explicit address decisions affect proposals, never the original source hash.
  for (const [id, handle] of Object.entries(options.resolutions?.handles ?? {})) {
    const user = effective.tables.users?.find((u) => String(u.id) === id)
    if (!user || typeof handle !== 'string') throw new TargetRefusal('IMPORT_RESOLUTION_INVALID')
    user.username = handle
  }
  for (const [id, slug] of Object.entries(options.resolutions?.slugs ?? {})) {
    const event = effective.tables.EventType?.find((e) => String(e.id) === id)
    if (!event || typeof slug !== 'string') throw new TargetRefusal('IMPORT_RESOLUTION_INVALID')
    event.slug = slug
  }
  const plan = parseImportPlan(effective, {
    target: parserContext(state, options.authorization),
    bookingDecisions: options.bookingDecisions,
  })
  if (
    plan.users.some(
      (u) =>
        !options.authorization.owners.some(
          (o) => o.sourceUserId === u.sourceId && o.targetUserId === u.targetUserId,
        ),
    )
  )
    throw new TargetRefusal('IMPORT_AUTHORIZATION_REQUIRED')
  const sourceFingerprint = fingerprint({
    tables: snapshot.tables,
    bookingExclusionCounts: snapshot.bookingExclusionCounts ?? [],
  })
  const entities: PreviewEntity[] = []
  const propose = (
    kind: EntityKind,
    id: number,
    userId: number,
    payload: unknown,
    matchId: string | null = null,
  ) => {
    const item = state.items.find(
      (i) => i.entity_kind === kind && i.source_primary_key === String(id),
    )
    // Whole selected snapshot intentionally invalidates all mappings on any source safety change.
    const sourceHash = fingerprint({
      sourceFingerprint,
      kind,
      id,
      // Preserve hashes written before optional weekly/monthly proposals existed.
      payload:
        kind === 'event_type'
          ? Object.fromEntries(
              Object.entries(payload as Record<string, unknown>).filter(
                ([key, value]) =>
                  !(['maxBookingsPerWeek', 'maxBookingsPerMonth'].includes(key) && value == null),
              ),
            )
          : payload,
      decisions: options.bookingDecisions,
      resolutions: options.resolutions ?? {},
    })
    let disposition: Disposition = kind === 'user' ? 'match' : 'create'
    let reason = kind === 'user' ? 'verified_owner_match' : 'new_entity'
    if (item) {
      const current = item.target_id ? entityState(state, kind, item.target_id) : undefined
      if (item.deleted_at || !current) {
        disposition = 'conflict'
        reason = 'target_deleted'
      } else if (item.source_fingerprint !== sourceHash) {
        disposition = 'conflict'
        reason = 'source_changed'
      } else if (item.target_fingerprint !== fingerprint(current)) {
        disposition = 'conflict'
        reason = 'target_changed'
      } else {
        disposition = 'noop'
        reason = 'unchanged_mapping'
      }
    }
    entities.push({
      kind,
      sourceKey: String(id),
      sourceUserId: userId,
      targetId: item?.target_id ?? matchId,
      disposition,
      reason,
      sourceFingerprint: sourceHash,
    })
  }
  for (const u of plan.users) {
    // Source identity hash must remain identical when a proposed profile becomes preserved.
    propose(
      'user',
      u.sourceId,
      u.sourceId,
      { targetUserId: u.targetUserId, organizationId: u.organizationId },
      u.targetUserId,
    )
    if (
      u.profileAction === 'propose' ||
      state.items.some(
        (i) => i.entity_kind === 'profile' && i.source_primary_key === String(u.sourceId),
      )
    )
      propose('profile', u.sourceId, u.sourceId, u.profile, u.targetUserId)
  }
  for (const s of plan.schedules.filter((s) => s.valid))
    propose('schedule', s.sourceId, s.sourceUserId, s)
  for (const e of plan.events) propose('event_type', e.sourceId, e.sourceUserId, e)
  for (const b of plan.bookings) propose('booking', b.sourceId, b.sourceUserId, b)
  const expected = new Set(entities.map((e) => entityKey(e.kind, e.sourceKey)))
  // A removed source entity must never disappear from the conflict report.
  for (const i of state.items) {
    if (!expected.has(entityKey(i.entity_kind, i.source_primary_key)))
      entities.push({
        kind: i.entity_kind,
        sourceKey: i.source_primary_key,
        sourceUserId: 0,
        targetId: i.target_id,
        disposition: 'conflict',
        reason: i.deleted_at ? 'target_deleted' : 'mapped_source_missing',
        sourceFingerprint: sourceFingerprint,
      })
  }
  if (!projectedTargetWithinLimits(state, entities, plan))
    throw new TargetRefusal('IMPORT_TARGET_LIMIT')
  const counts: PreviewPlan['counts'] = []
  const count = (entity: string, disposition: Disposition, reason: string, amount = 1) => {
    const prior = counts.find(
      (c) => c.entity === entity && c.disposition === disposition && c.reason === reason,
    )
    if (prior) prior.count += amount
    else counts.push({ entity, disposition, reason, count: amount })
  }
  for (const e of entities) count(e.kind, e.disposition, e.reason)
  for (const e of manualExclusions) count(e.table, 'excluded', 'operator_excluded')
  for (const p of plan.problems)
    count(
      p.source.table,
      p.severity === 'import_blocker'
        ? 'block'
        : p.severity === 'excluded'
          ? 'excluded'
          : 'warning',
      p.code,
    )
  for (const c of plan.bookingExclusionCounts) {
    if (c.pastOrStarted) count('booking', 'excluded', 'past_or_started', c.pastOrStarted)
    if (c.terminal) count('booking', 'excluded', 'cancelled_or_rejected', c.terminal)
  }
  const addresses: PreviewPlan['addresses'] = [
    ...plan.users.map((u) => ({
      kind: 'handle' as const,
      sourceId: u.sourceId,
      old: String(snapshot.tables.users?.find((r) => r.id === u.sourceId)?.username ?? ''),
      proposed: u.profile.handle,
      action: u.profileAction,
    })),
    ...plan.events.map((e) => ({
      kind: 'slug' as const,
      sourceId: e.sourceId,
      old: String(snapshot.tables.EventType?.find((r) => r.id === e.sourceId)?.slug ?? ''),
      proposed: `/${plan.users.find((u) => u.sourceId === e.sourceUserId)?.profile.handle}/${e.slug}`,
      action: 'inactive_draft',
    })),
  ]
  const identities = (snapshot.tables.users ?? []).map((u) => ({
    sourceId: u.id as number,
    email: typeof u.email === 'string' ? u.email : null,
    targetIds: state.identities
      .filter((t) => String(t.email).trim().toLowerCase() === String(u.email).trim().toLowerCase())
      .map((t) => t.id),
    authorizedTargetId:
      options.authorization.owners.find((o) => o.sourceUserId === u.id)?.targetUserId ?? null,
  }))
  const bookingTimes = (snapshot.tables.Booking ?? [])
    .filter((b) => validInstant(b.startTime) && validInstant(b.endTime))
    .map((b) => {
      const zone = plan.users.find((u) => u.sourceId === b.userId)?.sourceTimezone ?? 'UTC'
      const accepted = plan.bookings.some((p) => p.sourceId === b.id)
      return {
        sourceId: b.id as number,
        startUtc: b.startTime as string,
        endUtc: b.endTime as string,
        startLocal: Temporal.Instant.from(b.startTime as string)
          .toZonedDateTimeISO(zone)
          .toString(),
        endLocal: Temporal.Instant.from(b.endTime as string)
          .toZonedDateTimeISO(zone)
          .toString(),
        disposition: accepted
          ? 'candidate'
          : plan.problems.some(
                (p) =>
                  p.source.table === 'Booking' &&
                  p.source.id === b.id &&
                  p.severity === 'import_blocker',
              )
            ? 'blocked'
            : 'excluded',
      }
    })
  const impacts: PreviewPlan['impacts'] = []
  for (const b of snapshot.tables.Booking ?? []) {
    const user = plan.users.find((u) => u.sourceId === b.userId)
    if (!user || b.status !== 'accepted' || !validInstant(b.startTime) || !validInstant(b.endTime))
      continue
    for (const slot of state.groupOccupancy) {
      if (
        slot.user_id === user.targetUserId &&
        Date.parse(b.startTime as string) < Date.parse(slot.end_at) &&
        Date.parse(b.endTime as string) > Date.parse(slot.start_at)
      )
        impacts.push({
          code: 'target_overlap',
          sourceBookingId: b.id as number,
          relatedId: slot.group_slot_id,
        })
    }
    for (const t of state.bookings) {
      if (
        t.status === 'cancelled' ||
        !(t.hosts as { user_id: string }[]).some((h) => h.user_id === user.targetUserId) ||
        state.items.some(
          (i) =>
            i.entity_kind === 'booking' &&
            i.source_primary_key === String(b.id) &&
            i.target_id === t.id,
        )
      )
        continue
      if (
        Date.parse(b.startTime as string) < Date.parse(t.end_at as string) &&
        Date.parse(b.endTime as string) > Date.parse(t.start_at as string)
      )
        impacts.push({ code: 'target_overlap', sourceBookingId: b.id as number, relatedId: t.id })
    }
    for (const other of snapshot.tables.Booking ?? []) {
      if (
        other.id === b.id ||
        other.userId !== b.userId ||
        other.status !== 'accepted' ||
        !validInstant(other.startTime) ||
        !validInstant(other.endTime)
      )
        continue
      if (
        Date.parse(b.startTime as string) < Date.parse(other.endTime as string) &&
        Date.parse(b.endTime as string) > Date.parse(other.startTime as string)
      )
        impacts.push({
          code: 'batch_overlap',
          sourceBookingId: b.id as number,
          relatedId: other.id as number,
        })
    }
  }
  for (const b of plan.bookings) {
    const event = plan.events.find((e) => e.sourceId === b.eventSourceId)
    if (!event) continue
    const start = Date.parse(b.start),
      end = Date.parse(b.end)
    const related = [
      ...state.groupOccupancy
        .filter((slot) => slot.user_id === b.targetUserId)
        .map((slot) => ({
          id: slot.group_slot_id,
          start: slot.start_at,
          end: slot.end_at,
          before: slot.buffer_before_minutes,
          after: slot.buffer_after_minutes,
          sameEvent: false,
        })),
      ...state.bookings
        .filter(
          (t) =>
            t.status !== 'cancelled' &&
            !state.items.some(
              (i) =>
                i.entity_kind === 'booking' &&
                plan.bookings.some(
                  (candidate) => i.source_primary_key === String(candidate.sourceId),
                ) &&
                i.target_id === t.id,
            ),
        )
        .filter((t) => (t.hosts as { user_id: string }[]).some((h) => h.user_id === b.targetUserId))
        .map((t) => ({
          id: t.id,
          start: t.start_at as string,
          end: t.end_at as string,
          before: t.event_buffer_before as number,
          after: t.event_buffer_after as number,
          sameEvent: state.items.some(
            (i) =>
              i.entity_kind === 'event_type' &&
              i.source_primary_key === String(b.eventSourceId) &&
              i.target_id === t.event_type_id,
          ),
        })),
      ...plan.bookings
        .filter((t) => t.sourceId !== b.sourceId && t.targetUserId === b.targetUserId)
        .map((t) => ({
          id: t.sourceId,
          start: t.start,
          end: t.end,
          before: plan.events.find((e) => e.sourceId === t.eventSourceId)?.bufferBeforeMinutes ?? 0,
          after: plan.events.find((e) => e.sourceId === t.eventSourceId)?.bufferAfterMinutes ?? 0,
          sameEvent: t.eventSourceId === b.eventSourceId,
        })),
    ]
    for (const r of related) {
      if (
        start - event.bufferBeforeMinutes * 60000 < Date.parse(r.end) + r.after * 60000 &&
        end + event.bufferAfterMinutes * 60000 > Date.parse(r.start) - r.before * 60000
      )
        impacts.push({ code: 'buffer_impact', sourceBookingId: b.sourceId, relatedId: r.id })
    }
    const zone =
      plan.schedules.find((s) => s.sourceId === b.scheduleSourceId)?.timeZone ??
      plan.users.find((u) => u.sourceId === b.sourceUserId)?.sourceTimezone ??
      'UTC'
    const day = (value: string) =>
      Temporal.Instant.from(value).toZonedDateTimeISO(zone).toPlainDate().toString()
    const daily = 1 + related.filter((r) => r.sameEvent && day(r.start) === day(b.start)).length
    impacts.push({
      code:
        event.maxBookingsPerDay != null && daily > event.maxBookingsPerDay
          ? 'daily_limit_exceeded'
          : 'daily_count',
      sourceBookingId: b.sourceId,
      relatedId: b.eventSourceId,
      count: daily,
      ...(event.maxBookingsPerDay != null ? { limit: event.maxBookingsPerDay } : {}),
    })
    const localDate = (value: string) =>
      Temporal.Instant.from(value).toZonedDateTimeISO(zone).toPlainDate()
    const week = (value: string) => {
      const date = localDate(value)
      return date.subtract({ days: date.dayOfWeek - 1 }).toString()
    }
    const month = (value: string) => localDate(value).with({ day: 1 }).toString()
    for (const [period, key, limit] of [
      ['weekly', week, event.maxBookingsPerWeek],
      ['monthly', month, event.maxBookingsPerMonth],
    ] as const) {
      const count = 1 + related.filter((r) => r.sameEvent && key(r.start) === key(b.start)).length
      impacts.push({
        code: limit != null && count > limit ? `${period}_limit_exceeded` : `${period}_count`,
        sourceBookingId: b.sourceId,
        relatedId: b.eventSourceId,
        count,
        ...(limit != null ? { limit } : {}),
      })
    }
    impacts.push({
      code: 'historical_time_preserved_review_schedule',
      sourceBookingId: b.sourceId,
      relatedId: b.scheduleSourceId ?? 0,
    })
  }
  const blocked =
    plan.userBatches.some((b) => b.disposition === 'blocked') ||
    entities.some((e) => e.disposition === 'conflict')
  const creates = (kind: EntityKind) =>
    entities.filter((e) => e.kind === kind && e.disposition === 'create')
  const writes = [
    { table: 'profiles', rows: creates('profile').length },
    { table: 'schedules', rows: creates('schedule').length },
    {
      table: 'schedule_overrides',
      rows: plan.schedules
        .filter((s) => creates('schedule').some((e) => e.sourceKey === String(s.sourceId)))
        .reduce((n, s) => n + s.overrides.length, 0),
    },
    { table: 'event_types', rows: creates('event_type').length },
    { table: 'event_type_hosts', rows: creates('event_type').length },
    { table: 'bookings', rows: creates('booking').length },
    { table: 'booking_hosts', rows: creates('booking').length },
    {
      table: 'waitlist_scan_signals',
      rows: state.waitlistEvents.reduce((sum, event) => {
        const userId = event.user_id
        const owned = (kind: EntityKind) =>
          entities.filter(
            (e) =>
              e.kind === kind &&
              e.disposition === 'create' &&
              plan.users.some((u) => u.sourceId === e.sourceUserId && u.targetUserId === userId),
          )
        return (
          sum +
          owned('profile').length +
          owned('schedule').length +
          owned('event_type').length +
          owned('booking').length +
          plan.schedules
            .filter(
              (s) =>
                s.targetUserId === userId &&
                owned('schedule').some((e) => e.sourceKey === String(s.sourceId)),
            )
            .reduce((n, s) => n + s.overrides.length, 0)
        )
      }, 0),
    },
    {
      table: 'booking_attendees',
      rows: plan.bookings
        .filter((b) => creates('booking').some((e) => e.sourceKey === String(b.sourceId)))
        .reduce((n, b) => n + b.attendees.length, 0),
    },
    {
      table: 'import_items',
      rows: entities.filter((e) => e.disposition === 'create' || e.disposition === 'match').length,
    },
  ].map((w) => ({ ...w, rows: blocked ? 0 : w.rows }))
  const value: Omit<PreviewPlan, 'planFingerprint'> = {
    formatVersion: 1,
    sourceId: options.sourceId,
    options,
    sourceFingerprint,
    targetFingerprint: fingerprint(state),
    schemaFingerprint: snapshot.schemaFingerprint,
    targetVersionFingerprint: fingerprint(state.versions),
    cutoff: snapshot.cutoff,
    extractedAt: snapshot.extractedAt,
    plan,
    entities,
    counts,
    addresses,
    identities,
    bookingTimes,
    impacts,
    writes,
    losses: plan.problems,
    inactiveEventSourceIds: plan.events.map((e) => e.sourceId),
    manualExclusions,
    reconnectProviders: ['calendar', 'conference'],
    externalEffects: {
      mail: 0,
      ics: 0,
      calendar: 0,
      conference: 0,
      webhook: 0,
      reminder: 0,
      repairJob: 0,
    },
    blocked,
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024)
    throw new TargetRefusal('IMPORT_TARGET_LIMIT')
  return { ...value, planFingerprint: fingerprint(value) }
}
export function verifyPlanFingerprint(plan: PreviewPlan): boolean {
  const { planFingerprint, ...value } = plan
  return fingerprint(value) === planFingerprint
}
// Per-entity hashes prove the committed batch. Unrelated schedules and global handle
// reservations may change afterwards without changing any imported entity.
export function allMappingsUnchanged(preview: PreviewPlan, state: TargetState): boolean {
  const users = state.items.filter(
    (i) =>
      i.entity_kind === 'user' &&
      preview.entities.some((e) => e.kind === 'user' && e.sourceKey === i.source_primary_key),
  )
  return (
    preview.entities.length > 0 &&
    preview.entities.every((e) => e.disposition === 'noop') &&
    users.length === preview.options.authorization.owners.length
  )
}
