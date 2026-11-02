import pg from 'pg'
import { safeMeetingUrl } from './locations.ts'
import { detectSchema, SOURCE_COLUMN_EXCEPTIONS, SOURCE_COLUMNS, SourceRefusal } from './schema.ts'
import {
  LIMITS,
  type SourceRow,
  type SourceSnapshot,
  type SourceTable,
  type SourceVersion,
  type TargetUser,
} from './types.ts'
import { matchIdentityRows, validInstant } from './users.ts'

export { SourceRefusal } from './schema.ts'
export interface ExtractOptions {
  connectionString: string
  sourceVersion: SourceVersion
  selectedUserIds: number[]
  targetUsers: readonly TargetUser[]
  /** Operator confirmation of the audited timestamp-without-time-zone UTC convention. */
  utcTimestampsConfirmed: true
  cutoff: string
}

export async function assertRestrictedRole(client: pg.PoolClient): Promise<void> {
  const role = await client.query<{ unsafe: boolean }>(`SELECT (
    r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit
    OR d.datdba=r.oid OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)
    OR pg_catalog.has_database_privilege(d.oid,'CREATE') OR pg_catalog.has_database_privilege(d.oid,'TEMP')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname<>'information_schema' AND pg_catalog.has_schema_privilege(n.oid,'CREATE'))
    ) AS unsafe FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=pg_catalog.current_database()
    WHERE r.rolname=CURRENT_USER`)
  if (role.rows.length !== 1 || role.rows[0]?.unsafe) {
    throw new SourceRefusal(
      'SOURCE_ROLE_UNSAFE',
      'Use a dedicated non-owner, non-inheriting role with only the audited SELECT permissions.',
    )
  }
  const permissions = await client.query<{
    schema: string
    table: string
    column: string
    readable: boolean
    writable: boolean
    owner: boolean
  }>(`
    SELECT n.nspname AS schema, c.relname AS "table", a.attname AS "column",
      pg_catalog.has_column_privilege(c.oid,a.attnum,'SELECT') AS readable,
      (pg_catalog.has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR pg_catalog.has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES')) AS writable,
      c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=CURRENT_USER) AS owner
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
    ORDER BY n.nspname,c.relname,a.attname`)
  for (const row of permissions.rows) {
    const allowed =
      row.schema === 'public' &&
      Object.hasOwn(SOURCE_COLUMNS, row.table) &&
      ((SOURCE_COLUMNS[row.table as keyof typeof SOURCE_COLUMNS] as readonly string[]).includes(
        row.column,
      ) ||
        ((row.table === 'EventType' || row.table === 'Booking') &&
          (SOURCE_COLUMN_EXCEPTIONS[row.table] as readonly string[]).includes(row.column)))
    if (row.writable || row.owner || (row.readable && !allowed)) {
      throw new SourceRefusal(
        'SOURCE_ROLE_UNSAFE',
        'The source role has ownership, write access or SELECT access outside the audited column allowlist.',
      )
    }
  }
  const sequences = await client.query<{ unsafe: boolean }>(`SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='S' AND n.nspname NOT LIKE 'pg_%' AND (
      pg_catalog.has_sequence_privilege(c.oid,'USAGE,UPDATE') OR
      c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=CURRENT_USER))) AS unsafe`)
  if (sequences.rows[0]?.unsafe)
    throw new SourceRefusal(
      'SOURCE_ROLE_UNSAFE',
      'The source role must not own or modify sequences.',
    )
}

const TIMESTAMP = new Set([
  'emailVerified',
  'periodStartDate',
  'periodEndDate',
  'createdAt',
  'updatedAt',
  'startDate',
  'endDate',
  'start',
  'end',
])
const BOOKING_MINIMAL_COLUMNS = new Set([
  'id',
  'userId',
  'eventTypeId',
  'startTime',
  'endTime',
  'status',
  'rescheduled',
])
// Match the parser's structural personal/single-host scope before reading answers or text.
const PERSONAL_BOOKING = `t.status='accepted' AND EXISTS(
  SELECT 1 FROM public."EventType" e WHERE e.id=t."eventTypeId" AND e."userId"=t."userId"
    AND e."teamId" IS NULL AND e."profileId" IS NULL AND e."parentId" IS NULL
    AND e."schedulingType" IS NULL AND NOT e."assignAllTeamMembers"
    AND NOT e."assignRRMembersUsingSegment" AND NOT e."rrHostSubsetEnabled"
    AND EXISTS(SELECT 1 FROM public."Host" h WHERE h."eventTypeId"=e.id AND h."userId"=t."userId"
      UNION ALL SELECT 1 FROM public._user_eventtype u WHERE u."A"=e.id AND u."B"=t."userId")
    AND NOT EXISTS(SELECT 1 FROM public."Host" h WHERE h."eventTypeId"=e.id
      AND (h."userId"<>t."userId" OR h."groupId" IS NOT NULL OR h."memberId" IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM public._user_eventtype u WHERE u."A"=e.id AND u."B"<>t."userId")
    AND NOT EXISTS(SELECT 1 FROM public."HostGroup" g WHERE g."eventTypeId"=e.id))`
function projection(table: SourceTable, alias: string, personalBookingOnly = false): string {
  return (SOURCE_COLUMNS[table] as readonly string[])
    .map((column) => {
      const value =
        personalBookingOnly && !BOOKING_MINIMAL_COLUMNS.has(column)
          ? `(CASE WHEN ${PERSONAL_BOOKING} THEN ${alias}."${column}" ELSE NULL END)`
          : `${alias}."${column}"`
      if (table === 'BookingReference' && column === 'meetingUrl')
        return `CASE WHEN ${alias}.deleted IS NULL AND ${alias}.type IN ('zoom_video','google_video','google_calendar','daily_video','office365_video','office365_calendar')
          AND ${value} ~* '^https?://' AND ${value} !~* '(://[^/]*@|/(start|admin|login|oauth)(/|\\?|$)|[?&](zak|access_token|refresh_token|id_token|client_secret|authorization|oauth_token)=)'
          THEN ${value} ELSE NULL END AS "meetingUrl"`
      if (
        TIMESTAMP.has(column) ||
        (table === 'Booking' && ['startTime', 'endTime'].includes(column))
      ) {
        return `pg_catalog.to_char(${value},'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "${column}"`
      }
      if (table === 'Availability' && column === 'date')
        return `pg_catalog.to_char(${value},'YYYY-MM-DD') AS "${column}"`
      if (table === 'Availability' && ['startTime', 'endTime'].includes(column))
        return `${value}::text AS "${column}"`
      return personalBookingOnly ? `${value} AS "${column}"` : value
    })
    .join(', ')
}
// This builder is private and takes only compile-time table constants. No input is SQL text.
const select = (table: SourceTable, where: string, order: string) =>
  `SELECT ${projection(table, 't')} FROM public."${table}" t WHERE ${where} ORDER BY ${order} LIMIT $2::int`
const EVENT_METADATA = `
  t.metadata->'multipleDuration' AS "multipleDuration",
  t.metadata->'hideDurationSelectorInBookingPage' AS "hideDurationSelectorInBookingPage",
  EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(t.metadata->'apps')='object'
    THEN t.metadata->'apps' ELSE '{}'::jsonb END) app WHERE app.key IN ('stripe','mock-payment-app') AND (
      app.value->'enabled'='true'::jsonb OR app.value ? 'paymentOption' OR
      (app.value ? 'price' AND app.value->'price' NOT IN ('0'::jsonb,'null'::jsonb)))) AS "paymentConfigured",
  (t.metadata IS NOT NULL AND pg_catalog.jsonb_typeof(t.metadata)<>'object' OR
   t.metadata ? 'apps' AND pg_catalog.jsonb_typeof(t.metadata->'apps') NOT IN ('object','null') OR
   EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(t.metadata->'apps')='object'
     THEN t.metadata->'apps' ELSE '{}'::jsonb END) app WHERE app.key NOT IN ('stripe','mock-payment-app') OR
       pg_catalog.jsonb_typeof(app.value)<>'object')) AS "unknownPaymentShape"`

function connectionOptions(connectionString: string): pg.PoolConfig {
  try {
    const url = new URL(connectionString)
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      url.pathname.length < 2 ||
      [...url.searchParams.keys()].some((key) => key !== 'sslmode')
    )
      throw new Error()
    return {
      connectionString,
      max: 1,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 1_000,
      query_timeout: 16_000,
      options: '-c search_path=pg_catalog',
      application_name: 'hourmere_calcom_dry_run',
    }
  } catch {
    throw new SourceRefusal(
      'SOURCE_CONNECTION_INVALID',
      'Use an explicitly configured PostgreSQL connection; only the sslmode URL option is accepted.',
    )
  }
}

/** Extract one bounded, consistent, read-only source snapshot and close it immediately. */
export async function extractSource(options: ExtractOptions): Promise<SourceSnapshot> {
  if (options.utcTimestampsConfirmed !== true) {
    throw new SourceRefusal(
      'SOURCE_UTC_UNCONFIRMED',
      'Confirm that source timestamp-without-time-zone values use UTC before extraction.',
    )
  }
  const cutoff = validInstant(options.cutoff)
  if (
    !cutoff ||
    options.selectedUserIds.length < 1 ||
    options.selectedUserIds.length > LIMITS.users ||
    new Set(options.selectedUserIds).size !== options.selectedUserIds.length ||
    options.selectedUserIds.some((id) => !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647)
  ) {
    throw new SourceRefusal(
      'SOURCE_SELECTION_INVALID',
      'Select a bounded set of distinct positive source user IDs and a fixed UTC cutoff.',
    )
  }
  const pool = new pg.Pool(connectionOptions(options.connectionString))
  // Driver errors can contain a host, DSN or provider payload; never log or attach them.
  pool.on('error', () => {})
  let client: pg.PoolClient | undefined
  let inTransaction = false
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    inTransaction = true
    await client.query("SET LOCAL timezone='UTC'")
    await client.query("SET LOCAL statement_timeout='15s'")
    await client.query("SET LOCAL lock_timeout='2s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'")
    const settings = await client.query<{
      readOnly: string
      timezone: string
      isolation: string
    }>(`SELECT
      pg_catalog.current_setting('transaction_read_only') AS "readOnly",
      pg_catalog.current_setting('TimeZone') AS timezone,
      pg_catalog.current_setting('transaction_isolation') AS isolation`)
    if (settings.rows[0]?.readOnly !== 'on')
      throw new SourceRefusal('SOURCE_NOT_READ_ONLY', 'The source transaction is not read-only.')
    if (settings.rows[0]?.timezone !== 'UTC')
      throw new SourceRefusal(
        'SOURCE_TIMEZONE_NOT_UTC',
        'The source transaction time zone must be UTC.',
      )
    if (settings.rows[0]?.isolation !== 'repeatable read')
      throw new SourceRefusal(
        'SOURCE_ISOLATION_UNSAFE',
        'A repeatable-read source snapshot is required.',
      )
    await assertRestrictedRole(client)
    const schemaFingerprint = await detectSchema(client, options.sourceVersion)
    const tables: SourceSnapshot['tables'] = {}
    let bookingExclusionCounts: SourceSnapshot['bookingExclusionCounts']
    let totalRows = 0
    let totalBytes = 0
    const read = async (
      table: SourceTable,
      sql: string,
      parameters: unknown[],
    ): Promise<SourceRow[]> => {
      // Measure only this same audited, bounded projection on the server before any
      // payload crosses the connection. No extra source column is authorized here.
      const footprint = await client?.query<{ rowCount: number; bytes: string; maxBytes: string }>(
        `SELECT pg_catalog.count(*)::int AS "rowCount",
          COALESCE(pg_catalog.sum(octets),0)::text AS bytes,
          COALESCE(pg_catalog.max(octets),0)::text AS "maxBytes"
        FROM (SELECT pg_catalog.octet_length(pg_catalog.row_to_json(projected)::text) AS octets
          FROM (${sql}) projected) measured`,
        parameters,
      )
      const projectedRows = footprint?.rows[0]?.rowCount ?? -1
      const projectedBytes = Number(footprint?.rows[0]?.bytes ?? -1) + projectedRows + 2
      const projectedMaxBytes = Number(footprint?.rows[0]?.maxBytes ?? -1)
      if (
        !Number.isSafeInteger(projectedRows) ||
        projectedRows < 0 ||
        !Number.isSafeInteger(projectedBytes) ||
        projectedBytes < 0 ||
        !Number.isSafeInteger(projectedMaxBytes) ||
        projectedMaxBytes < 0 ||
        projectedRows > LIMITS.perTable ||
        totalRows + projectedRows > LIMITS.totalRows ||
        projectedBytes > LIMITS.snapshotBytes - totalBytes ||
        projectedMaxBytes > LIMITS.jsonBytes
      ) {
        throw new SourceRefusal(
          'SOURCE_LIMIT_EXCEEDED',
          'The source selection exceeds extraction limits. Select fewer users or resolve oversized input.',
        )
      }
      const rows: SourceRow[] = []
      const pageSize = 100
      const pageSql = `SELECT projected.* FROM (${sql}) projected LIMIT $${parameters.length + 1}::int OFFSET $${parameters.length + 2}::int`
      for (let offset = 0; offset < projectedRows; offset += pageSize) {
        const page = await client?.query<SourceRow>(pageSql, [...parameters, pageSize, offset])
        rows.push(...(page?.rows ?? []))
      }
      if (rows.length !== projectedRows)
        throw new SourceRefusal(
          'SOURCE_EXTRACTION_FAILED',
          'The source snapshot did not return the exact preflight row count.',
        )
      for (const row of rows) {
        if (
          table === 'Booking' &&
          typeof row.location === 'string' &&
          /^https?:/i.test(row.location) &&
          !safeMeetingUrl(row.location)
        ) {
          row.location = null
          row.unsafeLocation = true
        }
        if (table === 'EventType' && Array.isArray(row.locations)) {
          row.locations = row.locations.map((location: unknown) => {
            if (!location || typeof location !== 'object' || Array.isArray(location))
              return location
            const item = location as SourceRow
            const link = item.link ?? item.url
            if (typeof link === 'string' && !safeMeetingUrl(link)) {
              row.unsafeLocation = true
              return { ...item, link: null, url: null }
            }
            return item
          })
        }
        if (
          table === 'BookingReference' &&
          row.meetingUrl != null &&
          !safeMeetingUrl(row.meetingUrl)
        ) {
          row.meetingUrl = null
          row.unsafeMeetingUrl = true
        }
      }
      totalRows += rows.length
      const bytes = Buffer.byteLength(JSON.stringify(rows))
      totalBytes += bytes
      if (
        rows.length > LIMITS.perTable ||
        totalRows > LIMITS.totalRows ||
        totalBytes > LIMITS.snapshotBytes ||
        rows.some((row) =>
          Object.values(row).some(
            (value) =>
              value !== null &&
              typeof value === 'object' &&
              Buffer.byteLength(JSON.stringify(value)) > LIMITS.jsonBytes,
          ),
        )
      ) {
        throw new SourceRefusal(
          'SOURCE_LIMIT_EXCEEDED',
          'The source selection exceeds extraction limits. Select fewer users or resolve oversized input.',
        )
      }
      tables[table] = rows
      return rows
    }
    const identities = await read(
      'users',
      `SELECT t.id,t.email,
      pg_catalog.to_char(t."emailVerified",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "emailVerified"
      FROM public.users t WHERE t.id=ANY($1::int[]) ORDER BY t.id LIMIT $2::int`,
      [options.selectedUserIds, LIMITS.users + 1],
    )
    const matched = matchIdentityRows(identities, options.targetUsers)
    if (matched.length) {
      const users = await read('users', select('users', 't.id=ANY($1::int[])', 't.id'), [
        matched,
        LIMITS.users + 1,
      ])
      tables.users = identities.map(
        (identity) => users.find((user) => user.id === identity.id) ?? identity,
      )
      // History/terminal exclusions need counts, not titles, answers, descriptions or attendees.
      const exclusionCounts = await client.query<{
        sourceUserId: number
        pastOrStarted: string
        terminal: string
      }>(
        `SELECT t."userId" AS "sourceUserId",
        pg_catalog.count(*) FILTER(WHERE t."startTime"<=$2::timestamp)::text AS "pastOrStarted",
        pg_catalog.count(*) FILTER(WHERE t."startTime">$2::timestamp AND t.status IN ('cancelled','rejected'))::text AS terminal
        FROM public."Booking" t WHERE t."userId"=ANY($1::int[])
        GROUP BY t."userId" ORDER BY t."userId"`,
        [matched, cutoff],
      )
      bookingExclusionCounts = exclusionCounts.rows.map((row) => ({
        sourceUserId: row.sourceUserId,
        pastOrStarted: Number(row.pastOrStarted),
        terminal: Number(row.terminal),
      }))
      if (
        bookingExclusionCounts.some(
          (row) => !Number.isSafeInteger(row.pastOrStarted) || !Number.isSafeInteger(row.terminal),
        )
      )
        throw new SourceRefusal(
          'SOURCE_LIMIT_EXCEEDED',
          'The source exclusion counts exceed supported limits.',
        )
      const bookings = await read(
        'Booking',
        `SELECT ${projection('Booking', 't', true)}, ${PERSONAL_BOOKING} AS "personalScope",
        EXISTS(SELECT 1 FROM public."Booking" successor WHERE successor."fromReschedule"=t.uid) AS "hasSuccessor",
        ARRAY(SELECT successor.id FROM public."Booking" successor WHERE successor."fromReschedule"=t.uid ORDER BY successor.id LIMIT 2) AS "successorIds",
        EXISTS(SELECT 1 FROM public."Payment" payment WHERE payment."bookingId"=t.id) AS "hasPayment",
        EXISTS(SELECT 1 FROM public."BookingSeat" seat WHERE seat."bookingId"=t.id) AS "hasSeats"
        FROM public."Booking" t WHERE t."userId"=ANY($1::int[])
          AND t."startTime">$3::timestamp AND t.status NOT IN ('cancelled','rejected')
        ORDER BY t.id LIMIT $2::int`,
        [matched, LIMITS.perTable + 1, cutoff],
      )
      // Successor proof needs only lineage/time/ownership, including terminal intermediates.
      // UNION deduplicates cycles; an outer cap refuses oversized graphs before transfer.
      const lineage = await read(
        'Booking',
        `WITH RECURSIVE chain(id) AS (
          SELECT t.id FROM public."Booking" t WHERE t.id=ANY($1::int[])
          UNION
          SELECT successor.id FROM chain
            JOIN public."Booking" predecessor ON predecessor.id=chain.id
            JOIN public."Booking" successor ON successor."fromReschedule"=predecessor.uid
        )
        SELECT t.id,t."userId",t."eventTypeId",t.status,t.rescheduled,
          pg_catalog.to_char(t."startTime",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startTime",
          pg_catalog.to_char(t."endTime",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endTime",
          EXISTS(SELECT 1 FROM public."Booking" successor WHERE successor."fromReschedule"=t.uid) AS "hasSuccessor",
          ARRAY(SELECT successor.id FROM public."Booking" successor WHERE successor."fromReschedule"=t.uid ORDER BY successor.id LIMIT 2) AS "successorIds",
          true AS "lineageOnly"
        FROM chain JOIN public."Booking" t ON t.id=chain.id WHERE NOT(t.id=ANY($3::int[]))
        ORDER BY t.id LIMIT $2::int`,
        [
          bookings.filter((row) => row.personalScope === true).map((row) => row.id),
          LIMITS.perTable + 1,
          bookings.map((row) => row.id),
        ],
      )
      if (bookings.length + lineage.length > LIMITS.perTable)
        throw new SourceRefusal(
          'SOURCE_LIMIT_EXCEEDED',
          'The source booking and lineage selection exceeds extraction limits.',
        )
      tables.Booking = [...bookings, ...lineage]
      const bookingEventIds = bookings
        .map((row) => row.eventTypeId)
        .filter((id): id is number => typeof id === 'number')
      const events = await read(
        'EventType',
        `SELECT ${projection('EventType', 't')},${EVENT_METADATA}
        FROM public."EventType" t WHERE t."userId"=ANY($1::int[]) OR t.id=ANY($3::int[]) OR
          EXISTS(SELECT 1 FROM public."Host" h WHERE h."eventTypeId"=t.id AND h."userId"=ANY($1::int[])) OR
          EXISTS(SELECT 1 FROM public._user_eventtype u WHERE u."A"=t.id AND u."B"=ANY($1::int[]))
        ORDER BY t.id LIMIT $2::int`,
        [matched, LIMITS.perTable + 1, bookingEventIds],
      )
      if (events.some((row) => row.unknownPaymentShape))
        throw new SourceRefusal(
          'SOURCE_PAYMENT_SHAPE_UNKNOWN',
          'Unrecognized application payment metadata blocks this adapter; no arbitrary provider payload was read.',
        )
      const eventIds = events.map((row) => row.id)
      for (const table of ['Profile', 'Membership'] as const)
        await read(
          table,
          select(
            table,
            't."userId"=ANY($1::int[])',
            table === 'Profile' ? 't.id' : 't."userId",t."teamId"',
          ),
          [matched, LIMITS.perTable + 1],
        )
      const hosts = await read(
        'Host',
        select('Host', 't."eventTypeId"=ANY($1::int[])', 't."eventTypeId",t."userId"'),
        [eventIds, LIMITS.perTable + 1],
      )
      for (const table of ['EventTypeCustomInput', 'HostGroup', 'HostLocation'] as const)
        await read(
          table,
          select(
            table,
            't."eventTypeId"=ANY($1::int[])',
            table === 'HostLocation' ? 't."eventTypeId",t."userId"' : 't.id',
          ),
          [eventIds, LIMITS.perTable + 1],
        )
      await read(
        '_user_eventtype',
        select('_user_eventtype', 't."A"=ANY($1::int[])', 't."A",t."B"'),
        [eventIds, LIMITS.perTable + 1],
      )
      const scheduleIds = [...events, ...hosts]
        .flatMap((row) => [row.scheduleId, row.restrictionScheduleId])
        .filter((id) => typeof id === 'number')
      const schedules = await read(
        'Schedule',
        select('Schedule', 't."userId"=ANY($1::int[]) OR t.id=ANY($3::int[])', 't.id'),
        [matched, LIMITS.perTable + 1, scheduleIds],
      )
      await read(
        'Availability',
        select(
          'Availability',
          't."userId"=ANY($1::int[]) OR t."scheduleId"=ANY($3::int[]) OR t."eventTypeId"=ANY($4::int[])',
          't.id',
        ),
        [
          matched,
          LIMITS.perTable + 1,
          schedules.filter((row) => matched.includes(row.userId as number)).map((row) => row.id),
          eventIds,
        ],
      )
      const teamIds = [
        ...events.map((row) => row.teamId),
        ...(tables.Membership ?? []).map((row) => row.teamId),
        ...(tables.Profile ?? []).map((row) => row.organizationId),
      ].filter((id) => typeof id === 'number')
      await read('Team', select('Team', 't.id=ANY($1::int[])', 't.id'), [
        teamIds,
        LIMITS.perTable + 1,
      ])
      await read(
        'TravelSchedule',
        select(
          'TravelSchedule',
          't."userId"=ANY($1::int[]) AND (t."endDate" IS NULL OR t."endDate">=$3::timestamp)',
          't."userId",t."startDate",t."endDate"',
        ),
        [matched, LIMITS.perTable + 1, cutoff],
      )
      await read(
        'OutOfOfficeEntry',
        select(
          'OutOfOfficeEntry',
          't."userId"=ANY($1::int[]) AND t.end>=$3::timestamp',
          't."userId",t.start,t.end',
        ),
        [matched, LIMITS.perTable + 1, cutoff],
      )
      await read(
        'UserHolidaySettings',
        select(
          'UserHolidaySettings',
          't."userId"=ANY($1::int[]) AND t."countryCode" IS NOT NULL',
          't."userId"',
        ),
        [matched, LIMITS.perTable + 1],
      )
      const relevantBookings = bookings
        .filter(
          (row) =>
            row.personalScope === true &&
            row.status === 'accepted' &&
            typeof row.startTime === 'string' &&
            validInstant(row.startTime) &&
            Temporal.Instant.compare(row.startTime, cutoff) > 0,
        )
        .map((row) => row.id)
      await read('Attendee', select('Attendee', 't."bookingId"=ANY($1::int[])', 't.id'), [
        relevantBookings,
        LIMITS.perTable + 1,
      ])
      await read(
        'BookingReference',
        `SELECT ${projection('BookingReference', 't')},
          (t."meetingUrl" IS NOT NULL AND t."meetingUrl"<>'' AND (
            t."meetingUrl" !~* '^https?://' OR t."meetingUrl" ~* '(://[^/]*@|/(start|admin|login|oauth)(/|\\?|$)|[?&](zak|access_token|refresh_token|id_token|client_secret|authorization|oauth_token)=)')) AS "unsafeMeetingUrl"
        FROM public."BookingReference" t JOIN public."Booking" b ON b.id=t."bookingId"
        WHERE t."bookingId"=ANY($1::int[]) AND (b.location IS NULL OR b.location !~* '^https?://')
        ORDER BY t."bookingId",t.type,t.deleted,t."meetingUrl" LIMIT $2::int`,
        [relevantBookings, LIMITS.perTable + 1],
      )
    }
    await client.query('COMMIT')
    inTransaction = false
    return {
      sourceVersion: options.sourceVersion,
      schemaFingerprint,
      extractedAt: new Date().toISOString(),
      cutoff,
      selectedUserIds: [...options.selectedUserIds],
      tables,
      ...(bookingExclusionCounts ? { bookingExclusionCounts } : {}),
    }
  } catch (error) {
    if (client && inTransaction) await client.query('ROLLBACK').catch(() => {})
    if (error instanceof SourceRefusal) throw error
    throw new SourceRefusal(
      'SOURCE_EXTRACTION_FAILED',
      'Source extraction failed. Check the protected connection, least-privilege grants and audited schema; driver details are withheld.',
    )
  } finally {
    client?.release()
    await pool.end().catch(() => {})
  }
}
