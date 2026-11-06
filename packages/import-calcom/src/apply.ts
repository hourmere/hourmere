import type pg from 'pg'
import { fingerprint } from './plan.ts'
import {
  allMappingsUnchanged,
  buildPreview,
  entityKey,
  extractForPreview,
  type PreviewPlan,
  type SourceInput,
  verifyPlanFingerprint,
} from './preview.ts'
import { entityState, readTargetState, TargetRefusal, validateAuthorization } from './target.ts'
import type { SourceSnapshot } from './types.ts'

export interface ApplyReport {
  status: 'applied' | 'noop' | 'failed'
  code: string
  sourceId: string | null
  committed: boolean
  created: { entity: string; count: number }[]
  failures: { code: string; stage: string; entity?: string; sourceKey?: string }[]
  users: {
    sourceUserId: number
    targetUserId: string
    status: 'applied' | 'noop' | 'failed'
    code: string
    created: { entity: string; count: number }[]
  }[]
  externalEffects: PreviewPlan['externalEffects']
}
const zeroEffects: PreviewPlan['externalEffects'] = {
  mail: 0,
  ics: 0,
  calendar: 0,
  conference: 0,
  webhook: 0,
  reminder: 0,
  repairJob: 0,
}
const safeCodes = new Set([
  'IMPORT_AUTHORIZATION_REQUIRED',
  'IMPORT_SELECTION_CHANGED',
  'IMPORT_SCHEMA_CHANGED',
  'IMPORT_SOURCE_CHANGED',
  'IMPORT_TARGET_CHANGED',
  'IMPORT_PLAN_INVALID',
  'IMPORT_PREVIEW_BLOCKED',
  'IMPORT_PLAN_EXPIRED',
  'IMPORT_SOURCE_UNKNOWN',
  'IMPORT_RESOLUTION_INVALID',
  'IMPORT_TARGET_LIMIT',
  'IMPORT_PARTIAL_MAPPING',
  'IMPORT_INTENT_CHANGED',
])
function failureCode(error: unknown): string {
  if (error instanceof TargetRefusal && safeCodes.has(error.code)) return error.code
  const sqlState = (error as { code?: unknown } | null)?.code
  if (sqlState === '23P01') return 'IMPORT_BOOKING_OVERLAP'
  if (sqlState === '23505') return 'IMPORT_UNIQUE_CONFLICT'
  if (sqlState === '40001' || sqlState === '40P01' || sqlState === '55P03' || sqlState === '57014')
    return 'IMPORT_CONCURRENT_CHANGE'
  if (sqlState === '23503' || sqlState === '23514') return 'IMPORT_CONSTRAINT_FAILED'
  // Source failures are already secret-free, but expose only the finite public code set.
  if (
    typeof sqlState === 'string' &&
    /^SOURCE_(CONNECTION_INVALID|EXTRACTION_FAILED|ISOLATION_UNSAFE|LIMIT_EXCEEDED|NOT_READ_ONLY|PAYMENT_SHAPE_UNKNOWN|ROLE_UNSAFE|SCHEMA_UNKNOWN|SELECTION_INVALID|TIMEZONE_NOT_UTC|UTC_UNCONFIRMED|VERSION_UNKNOWN)$/.test(
      sqlState,
    )
  )
    return sqlState
  return 'IMPORT_APPLY_FAILED'
}
/** Re-extraction is deliberately outside the target transaction and closes immediately. */
export async function applyImport(
  pool: pg.Pool,
  saved: PreviewPlan,
  input: SourceInput,
): Promise<ApplyReport> {
  return applyExtractedImport(pool, saved, input, () =>
    extractForPreview(pool, input, saved.cutoff),
  )
}

/** Shared transaction engine; the extractor callback is used by synthetic source tests. */
export async function applyExtractedImport(
  pool: pg.Pool,
  saved: PreviewPlan,
  input: SourceInput,
  reextract: () => Promise<SourceSnapshot>,
): Promise<ApplyReport> {
  let stage = 'validate_plan',
    entity: string | undefined,
    sourceKey: string | undefined
  let client: pg.PoolClient | undefined,
    locked = false,
    inTransaction = false,
    committed = false
  const counts = new Map<string, number>()
  const userCounts = new Map<number, Map<string, number>>()
  const report = (status: ApplyReport['status'], code: string): ApplyReport => ({
    status,
    code,
    sourceId:
      typeof saved?.sourceId === 'string' && /^[a-f0-9-]{36}$/i.test(saved.sourceId)
        ? saved.sourceId
        : null,
    committed,
    created: committed ? [...counts].map(([entity, count]) => ({ entity, count })) : [],
    failures:
      status === 'failed'
        ? [{ code, stage, ...(entity ? { entity } : {}), ...(sourceKey ? { sourceKey } : {}) }]
        : [],
    users: Array.isArray(input?.authorization?.owners)
      ? input.authorization.owners
          .filter(
            (o) =>
              Number.isSafeInteger(o?.sourceUserId) &&
              o.sourceUserId > 0 &&
              /^[a-f0-9-]{36}$/i.test(o?.targetUserId),
          )
          .map((o) => ({
            sourceUserId: o.sourceUserId,
            targetUserId: o.targetUserId,
            status,
            code,
            created: committed
              ? [...(userCounts.get(o.sourceUserId) ?? new Map<string, number>())].map(
                  ([entity, count]) => ({ entity, count }),
                )
              : [],
          }))
      : [],
    externalEffects: { ...zeroEffects },
  })
  try {
    const { connectionString: _connectionString, ...options } = input
    if (
      !validateAuthorization(input.authorization) ||
      !saved ||
      saved.formatVersion !== 1 ||
      !verifyPlanFingerprint(saved) ||
      fingerprint(saved.options) !== fingerprint(options)
    )
      throw new TargetRefusal('IMPORT_PLAN_INVALID')
    if (saved.blocked) throw new TargetRefusal('IMPORT_PREVIEW_BLOCKED')
    stage = 'extract_source'
    const snapshot = await reextract()
    if (
      snapshot.cutoff !== saved.cutoff ||
      snapshot.schemaFingerprint !== saved.schemaFingerprint ||
      fingerprint({
        tables: snapshot.tables,
        bookingExclusionCounts: snapshot.bookingExclusionCounts ?? [],
      }) !== saved.sourceFingerprint
    )
      throw new TargetRefusal('IMPORT_SOURCE_CHANGED')
    stage = 'lock_target'
    client = await pool.connect()
    // Session lock before BEGIN: a competing apply starts its snapshot after our commit.
    // The source-wide lock is stricter than source+user and also serializes shared crosswalks.
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      `calcom-import:${input.sourceId}`,
    ])
    locked = true
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    inTransaction = true
    await client.query("SET LOCAL statement_timeout='30s'")
    await client.query("SET LOCAL lock_timeout='5s'")
    // A migration-only write barrier covers hash predicates as well as existing rows.
    // Ordinary profile/schedule writers do not all share one advisory-lock protocol.
    // Acquire every barrier before the first target snapshot; waiting writers resume
    // after commit/rollback. Source extraction has already closed its connection.
    await client.query(`LOCK TABLE auth."user",auth.organization,auth.member,
      personal_organizations,profiles,schedules,schedule_overrides,event_types,event_type_hosts,
      bookings,booking_hosts,group_slots,booking_attendees,import_sources,import_items,schema_migrations,
      waitlist_entries IN SHARE ROW EXCLUSIVE MODE`)
    await client.query(
      'SELECT id FROM auth."user" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [
        [
          input.authorization.operatorUserId,
          ...input.authorization.owners.map((o) => o.targetUserId),
        ],
      ],
    )
    await client.query(
      `SELECT o.id FROM auth.organization o JOIN personal_organizations p
      ON p.organization_id=o.id WHERE p.user_id=ANY($1::uuid[]) ORDER BY o.id FOR UPDATE OF o`,
      [input.authorization.owners.map((o) => o.targetUserId)],
    )
    stage = 'verify_target'
    const state = await readTargetState(client, input.sourceId, input.authorization, saved.cutoff)
    const fresh = buildPreview(snapshot, state, options)
    if (fresh.targetVersionFingerprint !== saved.targetVersionFingerprint)
      throw new TargetRefusal('IMPORT_SCHEMA_CHANGED')
    if (fresh.blocked) throw new TargetRefusal('IMPORT_TARGET_CHANGED')
    // Lost-response replay verifies the complete durable ledger and each mapped entity.
    if (
      allMappingsUnchanged(fresh, state) ||
      (fresh.targetFingerprint === saved.targetFingerprint &&
        fresh.entities.length > 0 &&
        fresh.entities.every((e) => e.disposition === 'noop'))
    ) {
      await client.query('COMMIT')
      inTransaction = false
      committed = true
      return report('noop', 'IMPORT_NOOP')
    }
    if (fresh.entities.some((e) => e.disposition === 'noop'))
      throw new TargetRefusal('IMPORT_PARTIAL_MAPPING')
    if (fresh.targetFingerprint !== saved.targetFingerprint)
      throw new TargetRefusal('IMPORT_TARGET_CHANGED')
    const comparable = {
      ...fresh,
      extractedAt: saved.extractedAt,
      plan: { ...fresh.plan, extractedAt: saved.plan.extractedAt },
      planFingerprint: '',
    }
    if (fingerprint(comparable) !== fingerprint({ ...saved, planFingerprint: '' }))
      throw new TargetRefusal('IMPORT_INTENT_CHANGED')
    const now = Temporal.Instant.from(
      (
        await client.query<{ now: string }>(
          'SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS now',
        )
      ).rows[0]?.now as string,
    )
    if (fresh.plan.bookings.some((b) => Temporal.Instant.compare(b.start, now) <= 0))
      throw new TargetRefusal('IMPORT_PLAN_EXPIRED')
    // The write barrier already locks bookings and host occupancy. Release due holds
    // before imported hosts hit the same overlap constraint as ordinary bookings.
    await client.query(
      `UPDATE bookings b SET status='expired'
       WHERE b.status='pending_payment' AND b.payment_hold_expires_at<=clock_timestamp()
         AND EXISTS (SELECT FROM booking_hosts h WHERE h.booking_id=b.id
           AND h.user_id=ANY($1::uuid[]))`,
      [input.authorization.owners.map((o) => o.targetUserId)],
    )
    stage = 'write_entities'
    const ids = new Map<string, string>()
    const remember = (kind: string, key: number, id: string, owner: number) => {
      ids.set(`${kind}:${key}`, id)
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
      const own = userCounts.get(owner) ?? new Map<string, number>()
      own.set(kind, (own.get(kind) ?? 0) + 1)
      userCounts.set(owner, own)
    }
    for (const u of fresh.plan.users) {
      entity = 'user'
      sourceKey = String(u.sourceId)
      ids.set(`user:${u.sourceId}`, u.targetUserId)
      if (u.profileAction === 'propose') {
        entity = 'profile'
        await client.query(
          'INSERT INTO profiles(user_id,handle,time_zone,locale) VALUES($1,$2,$3,$4)',
          [u.targetUserId, u.profile.handle, u.profile.timeZone, u.profile.locale],
        )
        remember('profile', u.sourceId, u.targetUserId, u.sourceId)
      }
    }
    for (const s of fresh.plan.schedules.filter((s) => s.valid)) {
      entity = 'schedule'
      sourceKey = String(s.sourceId)
      const id = (
        await client.query<{ id: string }>(
          `INSERT INTO schedules
        (user_id,name,time_zone,weekly_hours,is_default) VALUES($1,$2,$3,$4,false) RETURNING id`,
          [s.targetUserId, s.name, s.timeZone, JSON.stringify(s.weeklyHours)],
        )
      ).rows[0]?.id as string
      remember('schedule', s.sourceId, id, s.sourceUserId)
      for (const o of s.overrides)
        await client.query(
          'INSERT INTO schedule_overrides(schedule_id,date,intervals) VALUES($1,$2,$3)',
          [id, o.date, JSON.stringify(o.intervals)],
        )
    }
    for (const e of fresh.plan.events) {
      entity = 'event_type'
      sourceKey = String(e.sourceId)
      const id = (
        await client.query<{ id: string }>(
          `INSERT INTO event_types
        (organization_id,owner_user_id,slug,title,description,duration_minutes,allowed_durations_minutes,
        slot_step_minutes,buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,
        booking_window_days,max_bookings_per_day,scheduling_type,location,questions,is_active,
        is_hidden,position,allow_guests,notifications,success_redirect,max_bookings_per_week,max_bookings_per_month)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'individual',$14,$15,false,$16,$17,$18,$19,NULL,$20,$21) RETURNING id`,
          [
            e.organizationId,
            e.targetUserId,
            e.slug,
            e.title,
            e.description,
            e.durationMinutes,
            e.allowedDurationsMinutes,
            e.slotStepMinutes,
            e.bufferBeforeMinutes,
            e.bufferAfterMinutes,
            e.minimumNoticeMinutes,
            e.bookingWindowDays,
            e.maxBookingsPerDay,
            e.location ? JSON.stringify(e.location) : null,
            JSON.stringify(e.questions),
            e.isHidden,
            e.position,
            e.allowGuests,
            JSON.stringify(e.notifications),
            e.maxBookingsPerWeek,
            e.maxBookingsPerMonth,
          ],
        )
      ).rows[0]?.id as string
      remember('event_type', e.sourceId, id, e.sourceUserId)
      await client.query(
        'INSERT INTO event_type_hosts(event_type_id,user_id,schedule_id) VALUES($1,$2,$3)',
        [
          id,
          e.targetUserId,
          e.scheduleSourceId == null ? null : ids.get(`schedule:${e.scheduleSourceId}`),
        ],
      )
    }
    for (const b of fresh.plan.bookings) {
      entity = 'booking'
      sourceKey = String(b.sourceId)
      const id = (
        await client.query<{ id: string }>(
          `INSERT INTO bookings
        (organization_id,event_type_id,status,start_at,end_at,title,location,responses,import_questions,
        manage_token_hash,rescheduled_from_id,source,required_host_user_ids,hosts_use_default_schedule,
        notification_snapshot,success_redirect,ical_organizer_name,ical_organizer_email)
        VALUES($1,$2,'confirmed',$3,$4,$5,$6,$7,$8,NULL,NULL,'import',$9,false,$10,NULL,NULL,NULL) RETURNING id`,
          [
            b.organizationId,
            ids.get(`event_type:${b.eventSourceId}`),
            b.start,
            b.end,
            b.title,
            b.location ? JSON.stringify(b.location) : null,
            JSON.stringify(b.responses),
            JSON.stringify(b.questions),
            b.requiredHostUserIds,
            JSON.stringify(b.notificationSnapshot),
          ],
        )
      ).rows[0]?.id as string
      remember('booking', b.sourceId, id, b.sourceUserId)
      await client.query(
        "INSERT INTO booking_hosts(booking_id,user_id,period,active) VALUES($1,$2,'empty'::tstzrange,false)",
        [id, b.targetUserId],
      )
      for (const a of b.attendees)
        await client.query(
          `INSERT INTO booking_attendees
        (booking_id,name,email,time_zone,locale,is_booker) VALUES($1,$2,$3,$4,$5,$6)`,
          [id, a.name, a.email, a.timeZone, a.locale, a.isBooker],
        )
    }
    stage = 'write_mappings'
    const after = await readTargetState(client, input.sourceId, input.authorization, saved.cutoff)
    for (const e of fresh.entities) {
      entity = e.kind
      sourceKey = e.sourceKey
      const id = ids.get(entityKey(e.kind, e.sourceKey))
      if (!id) throw new TargetRefusal('IMPORT_PARTIAL_MAPPING')
      const crosswalk =
        e.kind === 'event_type'
          ? {
              questions:
                fresh.plan.events.find((p) => String(p.sourceId) === e.sourceKey)
                  ?.questionCrosswalk ?? [],
            }
          : e.kind === 'booking'
            ? {
                questions:
                  fresh.plan.bookings.find((p) => String(p.sourceId) === e.sourceKey)?.questions ??
                  [],
              }
            : {}
      await client.query(
        `INSERT INTO import_items(source_id,entity_kind,source_primary_key,source_user_primary_key,target_id,
        source_fingerprint,target_fingerprint,policy,contract_version,question_crosswalk)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9)`,
        [
          input.sourceId,
          e.kind,
          e.sourceKey,
          String(e.sourceUserId),
          id,
          e.sourceFingerprint,
          fingerprint(entityState(after, e.kind, id)),
          e.kind === 'booking'
            ? 'local_only_read_only'
            : e.kind === 'user'
              ? 'verified_owner_match'
              : 'inactive_import',
          JSON.stringify(crosswalk),
        ],
      )
    }
    // Capacity is checked with the committed ledger shape too, before COMMIT, so
    // a successful batch can always be loaded for lost-response replay.
    await readTargetState(client, input.sourceId, input.authorization, saved.cutoff)
    // Recheck DB wall time after the last potentially blocking write.
    if (fresh.plan.bookings.length) {
      const expired = await client.query(
        'SELECT 1 FROM bookings WHERE id=ANY($1::uuid[]) AND start_at<=clock_timestamp() LIMIT 1',
        [
          fresh.entities
            .filter((e) => e.kind === 'booking')
            .map((e) => ids.get(entityKey(e.kind, e.sourceKey))),
        ],
      )
      if (expired.rowCount) throw new TargetRefusal('IMPORT_PLAN_EXPIRED')
    }
    stage = 'commit'
    await client.query('COMMIT')
    inTransaction = false
    committed = true
    return report('applied', 'IMPORT_APPLIED')
  } catch (error) {
    if (inTransaction) await client?.query('ROLLBACK').catch(() => {})
    return report('failed', failureCode(error))
  } finally {
    if (locked)
      await client
        ?.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
          `calcom-import:${input.sourceId}`,
        ])
        .catch(() => {})
    client?.release(true)
  }
}
