// Audited scalar and relation signatures of cal.diy a5ee96f77edd and Cal.com v6.2.0.
// The two baselines share this import surface; the supplied version is recorded separately.
// Schema catalog inspection never reads application values from non-allowlisted columns.
import { createHash } from 'node:crypto'
import type pg from 'pg'
import { BASELINE_COLUMNS, BASELINE_ENUMS, BASELINE_RELATIONS } from './source-baselines.ts'
import type { SourceVersion } from './types.ts'

export const SOURCE_COLUMNS = {
  users: [
    'id',
    'email',
    'emailVerified',
    'username',
    'name',
    'timeZone',
    'locale',
    'defaultScheduleId',
    'organizationId',
    'movedToProfileId',
    'bufferTime',
  ],
  Profile: ['id', 'userId', 'organizationId', 'username'],
  EventType: [
    'id',
    'userId',
    'teamId',
    'profileId',
    'parentId',
    'title',
    'slug',
    'length',
    'description',
    'position',
    'locations',
    'bookingFields',
    'timeZone',
    'periodType',
    'periodStartDate',
    'periodEndDate',
    'periodDays',
    'periodCountCalendarDays',
    'minimumBookingNotice',
    'beforeEventBuffer',
    'afterEventBuffer',
    'hidden',
    'slotInterval',
    'offsetStart',
    'scheduleId',
    'schedulingType',
    'disableGuests',
    'requiresConfirmation',
    'requiresConfirmationWillBlockSlot',
    'requiresConfirmationForFreeEmail',
    'requiresBookerEmailVerification',
    'bookingRequiresAuthentication',
    'recurringEvent',
    'seatsPerTimeSlot',
    'disableCancelling',
    'disableRescheduling',
    'minimumRescheduleNotice',
    'useBookerTimezone',
    'restrictionScheduleId',
    'enablePerHostLocations',
    'maxActiveBookingsPerBooker',
    'bookingLimits',
    'durationLimits',
    'createdAt',
    'updatedAt',
    'price',
    'isInstantEvent',
    'assignAllTeamMembers',
    'assignRRMembersUsingSegment',
    'rrHostSubsetEnabled',
  ],
  EventTypeCustomInput: [
    'id',
    'eventTypeId',
    'label',
    'type',
    'options',
    'required',
    'placeholder',
  ],
  Host: ['eventTypeId', 'userId', 'scheduleId', 'groupId', 'memberId'],
  Schedule: ['id', 'userId', 'name', 'timeZone'],
  Availability: [
    'id',
    'userId',
    'eventTypeId',
    'scheduleId',
    'days',
    'startTime',
    'endTime',
    'date',
  ],
  Booking: [
    'id',
    'userId',
    'eventTypeId',
    'title',
    'startTime',
    'endTime',
    'status',
    'location',
    'responses',
    'customInputs',
    'createdAt',
    'updatedAt',
    'rescheduled',
    'recurringEventId',
    'paid',
    'description',
    'dynamicEventSlugRef',
    'dynamicGroupSlugRef',
  ],
  BookingSeat: ['bookingId'],
  Attendee: ['id', 'bookingId', 'name', 'email', 'timeZone', 'locale'],
  Team: ['id'],
  Membership: ['teamId', 'userId'],
  TravelSchedule: ['userId', 'startDate', 'endDate'],
  OutOfOfficeEntry: ['userId', 'start', 'end'],
  UserHolidaySettings: ['userId', 'countryCode'],
  HostGroup: ['id', 'eventTypeId'],
  HostLocation: ['userId', 'eventTypeId'],
  _user_eventtype: ['A', 'B'],
  BookingReference: ['bookingId', 'type', 'deleted', 'meetingUrl'],
  Payment: ['bookingId'],
} as const

/** Privileges required only for fixed JSON-path/predicate projections, never raw output. */
export const SOURCE_COLUMN_EXCEPTIONS = {
  EventType: ['metadata'],
  Booking: ['uid', 'fromReschedule'],
} as const

export class SourceRefusal extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'SourceRefusal'
  }
}

/** Catalog-only queries: no source values, arbitrary SQL, views or search-path resolution. */
export async function detectSchema(client: pg.PoolClient, version: SourceVersion): Promise<string> {
  if (version !== 'cal.diy-a5ee96f77edd' && version !== 'cal.com-v6.2.0') {
    throw new SourceRefusal(
      'SOURCE_VERSION_UNKNOWN',
      'The supplied source version has no audited adapter.',
    )
  }
  const expectedColumns = BASELINE_COLUMNS[version]
  const expectedEnums = BASELINE_ENUMS[version]
  const names = Object.keys(expectedColumns)
  const columns = await client.query<{
    table: string
    column: string
    type: string
    precision: number
    required: boolean
    kind: string
    rls: boolean
  }>(
    `SELECT c.relname AS "table", a.attname AS "column", t.typname AS type,
      a.atttypmod AS precision, a.attnotnull AS required, c.relkind AS kind,
      c.relrowsecurity AS rls
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
    WHERE n.nspname='public' AND c.relname=ANY($1::text[])
    ORDER BY c.relname, a.attname`,
    [names],
  )
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const actual = columns.rows.filter((r) => r.table === table)
    if (actual.length !== Object.keys(expected).length) {
      throw new SourceRefusal(
        'SOURCE_SCHEMA_UNKNOWN',
        'Source columns do not match the selected audited baseline.',
      )
    }
    for (const [column, signature] of Object.entries(expected)) {
      const row = actual.find((r) => r.column === column)
      const type = signature.replace(/\?$/, '')
      if (
        row?.kind !== 'r' ||
        row.rls ||
        row.type !== type ||
        row.required !== !signature.endsWith('?') ||
        (type === 'timestamp' && row.precision !== 3) ||
        (type === 'time' && row.precision !== -1 && row.precision !== 6)
      ) {
        throw new SourceRefusal(
          'SOURCE_SCHEMA_UNKNOWN',
          'The source schema does not match an audited baseline. No data was extracted.',
        )
      }
    }
  }
  const enums = await client.query<{ name: string; labels: string[] }>(
    `SELECT t.typname AS name,
      pg_catalog.array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    JOIN pg_catalog.pg_enum e ON e.enumtypid=t.oid
    WHERE n.nspname='public' AND t.typname=ANY($1::text[]) GROUP BY t.typname ORDER BY t.typname`,
    [Object.keys(expectedEnums)],
  )
  for (const [name, labels] of Object.entries(expectedEnums)) {
    if (
      JSON.stringify(enums.rows.find((e) => e.name === name)?.labels) !== JSON.stringify(labels)
    ) {
      throw new SourceRefusal(
        'SOURCE_SCHEMA_UNKNOWN',
        'The source enum labels do not match an audited baseline.',
      )
    }
  }
  const relations = await client.query<{
    table: string
    columns: string[]
    target: string
    targetSchema: string
    references: string[]
  }>(
    `
    SELECT c.relname AS "table", f.relname AS target, nf.nspname AS "targetSchema",
      ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY u(id,pos)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=u.id ORDER BY u.pos) AS columns,
      ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(k.confkey) WITH ORDINALITY u(id,pos)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=f.oid AND a.attnum=u.id ORDER BY u.pos) AS references
    FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
    JOIN pg_catalog.pg_class f ON f.oid=k.confrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_namespace nf ON nf.oid=f.relnamespace
    WHERE k.contype='f' AND n.nspname='public' 
      AND c.relname=ANY($1::text[])
    ORDER BY c.relname, f.relname, k.conname`,
    [names],
  )
  for (const [table, own, target, referenced] of BASELINE_RELATIONS[version]) {
    if (
      !relations.rows.some(
        (r) =>
          r.table === table &&
          r.targetSchema === 'public' &&
          r.target === target &&
          JSON.stringify(r.columns) === JSON.stringify(own) &&
          JSON.stringify(r.references) === JSON.stringify(referenced),
      )
    ) {
      throw new SourceRefusal(
        'SOURCE_SCHEMA_UNKNOWN',
        'Required source relationships are missing or unrecognized.',
      )
    }
  }
  if (relations.rows.length !== BASELINE_RELATIONS[version].length) {
    throw new SourceRefusal(
      'SOURCE_SCHEMA_UNKNOWN',
      'The source has unaudited foreign-key relationships.',
    )
  }
  // Names, types, enums and relation shapes only: no PII or credentials enter this fingerprint.
  return createHash('sha256')
    .update(
      JSON.stringify({
        version,
        columns: columns.rows,
        enums: enums.rows,
        relations: relations.rows,
      }),
    )
    .digest('hex')
}
