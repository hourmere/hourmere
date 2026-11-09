import type pg from 'pg'
import { fingerprint } from './plan.ts'
import type { SourceSnapshot, TargetContext, TargetUser } from './types.ts'
import { UUID } from './users.ts'

export interface ImportAuthorization {
  operatorUserId: string
  operatorAuthorized: true
  owners: { sourceUserId: number; targetUserId: string; importPersonalData: true }[]
}
export type EntityKind = 'user' | 'profile' | 'schedule' | 'event_type' | 'booking'
export interface ImportItem {
  source_id: string
  entity_kind: EntityKind
  source_primary_key: string
  source_user_primary_key: string | null
  target_id: string | null
  source_fingerprint: string | null
  target_fingerprint: string | null
  policy: string | null
  contract_version: number
  question_crosswalk: Record<string, unknown>
  deleted_at: string | null
}
export type TargetRow = Record<string, unknown> & { id: string }
export interface TargetState {
  source: { id: string; schema_fingerprint: string; source_version: string }
  versions: { name: string; checksum: string }[]
  operator: { id: string; emailVerified: boolean }[]
  identities: TargetRow[]
  handles: { user_id: string; handle: string }[]
  schedules: TargetRow[]
  events: TargetRow[]
  bookings: TargetRow[]
  groupOccupancy: {
    group_slot_id: string
    user_id: string
    start_at: string
    end_at: string
    buffer_before_minutes: number
    buffer_after_minutes: number
  }[]
  waitlistEvents: { user_id: string; event_type_id: string }[]
  items: ImportItem[]
}
export class TargetRefusal extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
    this.name = 'TargetRefusal'
  }
}
export function validateAuthorization(value: unknown): value is ImportAuthorization {
  if (!value || typeof value !== 'object') return false
  const a = value as ImportAuthorization
  return (
    UUID.test(a.operatorUserId) &&
    a.operatorAuthorized === true &&
    Array.isArray(a.owners) &&
    a.owners.length > 0 &&
    a.owners.length <= 25 &&
    a.owners.every(
      (o) =>
        o &&
        Number.isSafeInteger(o.sourceUserId) &&
        o.sourceUserId > 0 &&
        UUID.test(o.targetUserId) &&
        o.importPersonalData === true,
    ) &&
    new Set(a.owners.map((o) => o.sourceUserId)).size === a.owners.length &&
    new Set(a.owners.map((o) => o.targetUserId)).size === a.owners.length
  )
}
type Reader = Pick<pg.PoolClient, 'query'>
async function rows<T>(client: Reader, query: string, values: unknown[] = []): Promise<T[]> {
  // pg Date objects must become instants before canonical hashing (never object {}).
  return JSON.parse(JSON.stringify((await client.query(query, values)).rows)) as T[]
}
export async function readTargetIdentities(
  client: Reader,
  authorization: ImportAuthorization,
): Promise<TargetRow[]> {
  return rows(
    client,
    `SELECT u.id,u.email,u."emailVerified",p.handle,p.time_zone,p.locale,
    po.organization_id,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'role',m.role)
      ORDER BY m.id) FROM auth.member m WHERE m."userId"=u.id
      AND m."organizationId"=po.organization_id),'[]'::jsonb) AS memberships
    FROM auth."user" u LEFT JOIN profiles p ON p.user_id=u.id
    LEFT JOIN personal_organizations po ON po.user_id=u.id
    WHERE u.id=ANY($1::uuid[]) OR lower(btrim(u.email)) IN
      (SELECT lower(btrim(email)) FROM auth."user" WHERE id=ANY($1::uuid[]))
    ORDER BY u.id`,
    [authorization.owners.map((o) => o.targetUserId)],
  )
}
export function targetUsers(
  identities: TargetRow[],
  authorization: ImportAuthorization,
): TargetUser[] {
  return identities.map((u) => ({
    id: u.id,
    email: u.email as string,
    emailVerified: u.emailVerified as boolean,
    personalOrganizationId: u.organization_id as string | null,
    authorized:
      authorization.owners.some((o) => o.targetUserId === u.id) &&
      Array.isArray(u.memberships) &&
      u.memberships.length === 1 &&
      (u.memberships[0] as { role: string }).role === 'owner',
    ...(u.handle != null
      ? {
          profile: {
            handle: u.handle as string,
            timeZone: u.time_zone as string,
            locale: u.locale as string,
          },
        }
      : {}),
  }))
}
export async function readTargetState(
  client: Reader,
  sourceId: string,
  authorization: ImportAuthorization,
  cutoff: string,
): Promise<TargetState> {
  const source = (
    await rows<TargetState['source']>(
      client,
      'SELECT id,schema_fingerprint,source_version FROM import_sources WHERE id=$1',
      [sourceId],
    )
  )[0]
  if (!source) throw new TargetRefusal('IMPORT_SOURCE_UNKNOWN')
  const identities = await readTargetIdentities(client, authorization)
  const userIds = authorization.owners.map((o) => o.targetUserId)
  const organizations = identities
    .filter((u) => userIds.includes(u.id))
    .map((u) => u.organization_id)
  const versions = await rows<TargetState['versions'][number]>(
    client,
    'SELECT name,checksum FROM schema_migrations ORDER BY name',
  )
  const operator = await rows<TargetState['operator'][number]>(
    client,
    'SELECT id,"emailVerified" FROM auth."user" WHERE id=$1',
    [authorization.operatorUserId],
  )
  const handles = await rows<TargetState['handles'][number]>(
    client,
    'SELECT user_id,handle FROM profiles ORDER BY user_id',
  )
  const schedules = await rows<TargetRow>(
    client,
    `SELECT s.id,s.user_id,s.name,s.time_zone,
    s.weekly_hours,s.is_default,
    coalesce((SELECT jsonb_agg(jsonb_build_object('date',o.date,'intervals',o.intervals)
      ORDER BY o.date) FROM schedule_overrides o WHERE o.schedule_id=s.id),'[]'::jsonb) AS overrides
    FROM schedules s WHERE s.user_id=ANY($1::uuid[]) ORDER BY s.id`,
    [userIds],
  )
  const events = await rows<TargetRow>(
    client,
    `SELECT e.id,e.organization_id,e.owner_user_id,e.slug,
    e.title,e.description,e.duration_minutes,e.allowed_durations_minutes,e.slot_step_minutes,
    e.buffer_before_minutes,e.buffer_after_minutes,e.minimum_notice_minutes,e.booking_window_days,
    e.max_bookings_per_day,e.max_bookings_per_week,e.max_bookings_per_month,e.scheduling_type,e.location,e.questions,e.is_active,e.is_hidden,
    e.position,e.allow_guests,e.notifications,e.success_redirect,e.deleted_at,
    coalesce((SELECT jsonb_agg(jsonb_build_object('user_id',h.user_id,'schedule_id',h.schedule_id,
      'destination_calendar_id',h.destination_calendar_id,'weight',h.weight) ORDER BY h.user_id)
      FROM event_type_hosts h WHERE h.event_type_id=e.id),'[]'::jsonb) AS hosts
    FROM event_types e WHERE e.organization_id=ANY($1::uuid[]) ORDER BY e.id`,
    [organizations],
  )
  const bookings = await rows<TargetRow>(
    client,
    `SELECT b.id,b.organization_id,b.event_type_id,
    b.status,b.payment_hold_expires_at,
    (b.payment_hold_expires_at>clock_timestamp()) AS payment_hold_active,
    b.start_at,b.end_at,b.title,b.location,b.responses,b.import_questions,b.source,
    b.rescheduled_from_id,b.hosts_use_default_schedule,b.required_host_user_ids,
    b.notification_snapshot,b.success_redirect,
    coalesce(et.buffer_before_minutes,0) AS event_buffer_before,
    coalesce(et.buffer_after_minutes,0) AS event_buffer_after,
    (b.manage_token_hash IS NOT NULL) AS has_manage_token,
    coalesce((SELECT jsonb_agg(jsonb_build_object('user_id',h.user_id)
      ORDER BY h.user_id) FROM booking_hosts h WHERE h.booking_id=b.id),'[]'::jsonb) AS hosts,
    coalesce((SELECT jsonb_agg(jsonb_build_object('name',a.name,'email',a.email,
      'time_zone',a.time_zone,'locale',a.locale,'is_booker',a.is_booker)
      ORDER BY a.is_booker DESC,a.email,a.id) FROM booking_attendees a WHERE a.booking_id=b.id),
      '[]'::jsonb) AS attendees
    FROM bookings b LEFT JOIN event_types et ON et.id=b.event_type_id WHERE (b.organization_id=ANY($1::uuid[]) OR EXISTS
      (SELECT FROM booking_hosts h WHERE h.booking_id=b.id AND h.user_id=ANY($2::uuid[])))
      AND (b.end_at+coalesce(et.buffer_after_minutes,0)*interval '1 minute'>$3::timestamptz OR EXISTS(SELECT FROM import_items i WHERE
        i.source_id=$4 AND i.entity_kind='booking' AND i.target_id=b.id)) ORDER BY b.id`,
    [organizations, userIds, cutoff, sourceId],
  )
  // Group seats have no booking-owned host row. Read the slot-owned occupancy
  // directly, using the same active interval protected by the exclusion constraint.
  const groupOccupancy = await rows<TargetState['groupOccupancy'][number]>(
    client,
    `SELECT h.group_slot_id,h.user_id,lower(h.period) AS start_at,upper(h.period) AS end_at,
      s.buffer_before_minutes,s.buffer_after_minutes
    FROM booking_hosts h JOIN group_slots s ON s.id=h.group_slot_id
    WHERE h.booking_id IS NULL AND h.group_slot_id IS NOT NULL
      AND h.active AND h.user_id=ANY($1::uuid[])
      AND upper(h.period)+s.buffer_after_minutes*interval '1 minute'>$2::timestamptz
    ORDER BY h.group_slot_id,h.user_id`,
    [userIds, cutoff],
  )
  const items = await rows<ImportItem>(
    client,
    `SELECT source_id,entity_kind,source_primary_key,source_user_primary_key,
    target_id,source_fingerprint,target_fingerprint,policy,contract_version,question_crosswalk,
    deleted_at FROM import_items WHERE source_id=$1 AND (source_user_primary_key=ANY($2::text[]) OR source_user_primary_key IS NULL) ORDER BY entity_kind,source_primary_key`,
    [sourceId, authorization.owners.map((o) => String(o.sourceUserId))],
  )
  const waitlistEvents = await rows<TargetState['waitlistEvents'][number]>(
    client,
    `SELECT h.user_id,h.event_type_id
    FROM event_type_hosts h JOIN event_types e ON e.id=h.event_type_id
    WHERE h.user_id=ANY($1::uuid[]) AND e.waitlist_enabled AND EXISTS
      (SELECT FROM waitlist_entries w WHERE w.event_type_id=e.id AND w.status IN ('active','notified')
        AND w.verified_at IS NOT NULL AND w.expires_at>now()) ORDER BY h.user_id,h.event_type_id`,
    [userIds],
  )
  if (
    [identities, handles, schedules, events, bookings, groupOccupancy, waitlistEvents].some(
      (list) => list.length > 10_000,
    ) ||
    items.length > 50_050
  )
    throw new TargetRefusal('IMPORT_TARGET_LIMIT')
  const state = {
    source,
    versions,
    operator,
    identities,
    handles,
    schedules,
    events,
    bookings,
    groupOccupancy,
    waitlistEvents,
    items,
  }
  if (Buffer.byteLength(JSON.stringify(state)) > 32 * 1024 * 1024)
    throw new TargetRefusal('IMPORT_TARGET_LIMIT')
  return state
}
/** Business state only: post-commit hashes do not recursively include ledger hashes. */
export function businessFingerprint(state: TargetState): string {
  const { items: _items, ...business } = state
  return fingerprint(business)
}
export function entityState(state: TargetState, kind: EntityKind, targetId: string): unknown {
  switch (kind) {
    case 'user':
      return state.identities.find((u) => u.id === targetId)
    case 'profile': {
      const u = state.identities.find((u) => u.id === targetId)
      return u?.handle == null
        ? undefined
        : { user_id: u.id, handle: u.handle, time_zone: u.time_zone, locale: u.locale }
    }
    case 'schedule':
      return state.schedules.find((s) => s.id === targetId)
    case 'event_type': {
      const event = state.events.find((e) => e.id === targetId && e.deleted_at == null)
      // Null ceilings were absent from older ledger hashes; configured ceilings
      // remain part of the hash so edits cannot be mistaken for an unchanged replay.
      return event
        ? Object.fromEntries(
            Object.entries(event).filter(
              ([key, value]) =>
                !(
                  ['max_bookings_per_week', 'max_bookings_per_month'].includes(key) && value == null
                ),
            ),
          )
        : undefined
    }
    case 'booking':
      return state.bookings.find((b) => b.id === targetId)
  }
}
export function parserContext(
  state: TargetState,
  authorization: ImportAuthorization,
): TargetContext {
  const mappedEvents = new Set(
    state.items.filter((i) => i.entity_kind === 'event_type').map((i) => i.target_id),
  )
  const mappedBookings = new Set(
    state.items.filter((i) => i.entity_kind === 'booking').map((i) => i.target_id),
  )
  return {
    users: targetUsers(state.identities, authorization),
    occupiedHandles: state.handles.map((p) => p.handle),
    occupiedSlugs: state.events
      .filter((e) => e.deleted_at == null && !mappedEvents.has(e.id))
      .map((e) => ({ organizationId: e.organization_id as string, slug: e.slug as string })),
    busy: state.bookings
      .filter(
        (b) =>
          (b.status === 'confirmed' ||
            (b.status === 'pending_payment' && b.payment_hold_active === true)) &&
          !mappedBookings.has(b.id),
      )
      .flatMap((b) =>
        (b.hosts as { user_id: string }[]).map((h) => ({
          targetUserId: h.user_id,
          start: b.start_at as string,
          end: b.end_at as string,
        })),
      )
      .concat(
        state.groupOccupancy.map((h) => ({
          targetUserId: h.user_id,
          start: h.start_at,
          end: h.end_at,
        })),
      ),
  }
}
export function assertAuthorization(
  state: TargetState,
  authorization: ImportAuthorization,
  snapshot: SourceSnapshot,
): void {
  if (
    !validateAuthorization(authorization) ||
    state.operator.length !== 1 ||
    state.operator[0]?.emailVerified !== true ||
    snapshot.selectedUserIds.length !== authorization.owners.length ||
    snapshot.selectedUserIds.some((id) => !authorization.owners.some((o) => o.sourceUserId === id))
  )
    throw new TargetRefusal('IMPORT_AUTHORIZATION_REQUIRED')
}
