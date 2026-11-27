import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  MIGRATION_COVERAGE_TIMEOUT,
  MIGRATION_REPLAY_TIMEOUT,
  useMigrationReplay,
} from './testing/migration-replay.ts'
import type { TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0187_microsoft_calendar_writeback.sql'
const dispatchIndexes = [
  ['booking_calendar_targets_microsoft_due', 'booking_calendar_targets'],
  ['group_slots_microsoft_due', 'group_slots'],
] as const

async function assertDispatchIndexes(pool: pg.Pool) {
  for (const [name, table] of dispatchIndexes) {
    await expect(
      pool.query(
        `SELECT pg_get_indexdef(indexrelid) AS definition
           FROM pg_index WHERE indexrelid = to_regclass($1) AND indisready AND indisvalid`,
        [`public.${name}`],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          definition:
            `CREATE INDEX ${name} ON public.${table} USING btree (((microsoft_writeback ->> 'nextAttemptAt'::text))) ` +
            `WHERE ((microsoft_writeback ->> 'status'::text) = ANY (ARRAY['pending'::text, 'retrying'::text]))`,
        },
      ],
    })
  }
}

async function seedPredecessor(pool: pg.Pool) {
  await pool.query(`
    DO $fixture$
    DECLARE
      host uuid;
      team uuid;
      google_connection uuid;
      graph_connection uuid;
      google_calendar uuid;
      graph_calendar uuid;
      service uuid;
      workshop uuid;
      booking uuid;
      slot uuid;
      seat uuid;
      prior_sync timestamptz := '2026-11-21T09:00:00.123456Z';
      meeting_start timestamptz := '2030-11-24T15:00:00Z';
      workshop_start timestamptz := '2030-11-24T18:30:00Z';
    BEGIN
      INSERT INTO auth."user" (name,email,"emailVerified")
        VALUES ('Host','host@example.test',true) RETURNING id INTO host;
      INSERT INTO auth.organization (name,slug,"createdAt")
        VALUES ('Test team','graph-writeback-upgrade',prior_sync) RETURNING id INTO team;
      INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
        VALUES (team,host,'owner',prior_sync);
      INSERT INTO calendar_connections (user_id,provider,external_account_id,credentials,scopes)
        VALUES (host,'google','synthetic-google',decode('abcd','hex'),
          ARRAY['https://www.googleapis.com/auth/calendar.events'])
        RETURNING id INTO google_connection;
      INSERT INTO calendar_connections (user_id,provider,external_account_id,credentials,scopes)
        VALUES (host,'microsoft','synthetic-microsoft',decode('cdef','hex'),
          ARRAY['Calendars.ReadBasic'])
        RETURNING id INTO graph_connection;
      INSERT INTO calendars (connection_id,external_id,name,access_role,is_primary)
        VALUES (google_connection,'synthetic-google','Work','owner',true)
        RETURNING id INTO google_calendar;
      INSERT INTO calendars (connection_id,external_id,name,access_role,check_conflicts,
          last_synced_at,sync_state)
        VALUES (graph_connection,'synthetic-outlook','Outlook','writer',true,prior_sync,
          '{"version":2,"start":"2026-11-18T00:00:00Z","end":"2028-01-01T00:00:00Z","timeZone":null}')
        RETURNING id INTO graph_calendar;
      INSERT INTO calendar_busy (calendar_id,external_event_id,period)
        VALUES (graph_calendar,'synthetic-graph-busy',tstzrange(meeting_start,meeting_start+interval '30 min','[)'));
      INSERT INTO profiles (user_id,handle,destination_calendar_id,time_zone)
        VALUES (host,'graph-calendar-host',google_calendar,'Europe/Paris');
      INSERT INTO event_types (organization_id,slug,title,duration_minutes)
        VALUES (team,'consultation','Consultation',30) RETURNING id INTO service;
      INSERT INTO event_types (organization_id,slug,title,duration_minutes,booking_mode,group_capacity,allow_guests)
        VALUES (team,'workshop','Workshop',45,'group',8,false) RETURNING id INTO workshop;
      INSERT INTO event_type_hosts (event_type_id,user_id)
        VALUES (service,host),(workshop,host);
      INSERT INTO bookings (organization_id,event_type_id,start_at,end_at,title,source,required_host_user_ids)
        VALUES (team,service,meeting_start,meeting_start+interval '30 min','Consultation','web',ARRAY[host])
        RETURNING id INTO booking;
      INSERT INTO booking_hosts (booking_id,user_id) VALUES (booking,host);
      INSERT INTO booking_attendees (booking_id,name,email,time_zone,is_booker)
        VALUES (booking,'Booker','booker@example.test','Europe/London',true);
      INSERT INTO booking_calendar_targets (root_booking_id,user_id,calendar_id)
        VALUES (booking,host,google_calendar);
      INSERT INTO booking_calendar_events (booking_id,calendar_id,external_event_id,etag)
        VALUES (booking,google_calendar,'synthetic-booking-event','synthetic-booking-etag');
      INSERT INTO group_slots
        (organization_id,event_type_id,original_event_type_id,host_user_id,host_time_zone,
         destination_calendar_id,start_at,end_at,capacity,title)
        VALUES (team,workshop,workshop,host,'Europe/Paris',google_calendar,workshop_start,
          workshop_start+interval '45 min',8,'Workshop') RETURNING id INTO slot;
      INSERT INTO booking_hosts (group_slot_id,user_id) VALUES (slot,host);
      INSERT INTO bookings (organization_id,event_type_id,start_at,end_at,title,source,
          group_slot_id,group_booker_key,required_host_user_ids)
        VALUES (team,workshop,workshop_start,workshop_start+interval '45 min','Workshop','web',
          slot,'attendee@example.test',ARRAY[host]) RETURNING id INTO seat;
      INSERT INTO booking_attendees (booking_id,name,email,time_zone,is_booker)
        VALUES (seat,'Attendee','attendee@example.test','Europe/Paris',true);
      INSERT INTO group_slot_calendar_events
        (group_slot_id,calendar_id,external_event_id,etag,count_revision)
        SELECT id,google_calendar,'synthetic-group-event','synthetic-group-etag',count_revision
          FROM group_slots WHERE id=slot;
    END $fixture$
  `)
}

async function originalRows(pool: pg.Pool) {
  const result = await pool.query(`
    SELECT 'profile' AS relation, to_jsonb(p) AS data, xmin::text, ctid::text FROM profiles p
    UNION ALL
    SELECT 'calendar', to_jsonb(c), xmin::text, ctid::text FROM calendars c
    UNION ALL
    SELECT 'busy', to_jsonb(b), xmin::text, ctid::text FROM calendar_busy b
    UNION ALL
    SELECT 'target', to_jsonb(t) - 'microsoft_writeback', xmin::text, ctid::text FROM booking_calendar_targets t
    UNION ALL
    SELECT 'booking_mapping', to_jsonb(e), xmin::text, ctid::text FROM booking_calendar_events e
    UNION ALL
    SELECT 'group_slot', to_jsonb(s) - 'microsoft_writeback', xmin::text, ctid::text FROM group_slots s
    UNION ALL
    SELECT 'group_mapping', to_jsonb(e), xmin::text, ctid::text FROM group_slot_calendar_events e
    ORDER BY relation, data
  `)
  return result.rows
}

describe.skipIf(!serverUrl)('Microsoft calendar writeback migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'fails an assertion when either due-work index is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertDispatchIndexes,
      })
      expect(report.problems).toEqual([])
      expect(report.results.map(({ status }) => status)).toEqual(['covered', 'covered'])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'preserves historical destinations and mirrors, matches a fresh schema, and reruns as a no-op',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false, tag: 'graph_write_up' })
        await seedPredecessor(upgraded.pool)
        const before = await originalRows(upgraded.pool)
        expect(before).toHaveLength(8)

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
        expect(await originalRows(upgraded.pool)).toEqual(before)
        await expect(
          upgraded.pool.query(`SELECT microsoft_writeback FROM booking_calendar_targets
          UNION ALL SELECT microsoft_writeback FROM group_slots`),
        ).resolves.toMatchObject({
          rows: [{ microsoft_writeback: null }, { microsoft_writeback: null }],
        })

        fresh = await predecessor.clone(undefined, { migrate: false, tag: 'graph_write_new' })
        await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([migration])
        expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
        await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([])
        await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
        expect(await originalRows(upgraded.pool)).toEqual(before)
      } finally {
        await Promise.all([upgraded?.drop(), fresh?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
