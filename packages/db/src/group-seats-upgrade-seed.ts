import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'

/** Build real historical data before each feature's migration, ending at 0058. */
export async function groupSeatsPredecessor(serverUrl: string, directory: string) {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file.slice(0, 4) <= '0058')
    .sort()
  const staging = await mkdtemp(join(tmpdir(), 'hourmere-group-predecessor-'))
  const copyThrough = async (checkpoint: string) => {
    for (const file of files.filter((file) => file.slice(0, 4) <= checkpoint))
      await copyFile(join(migrationsDir, file), join(staging, file))
  }
  let owned: Awaited<ReturnType<typeof createTestDatabase>> | undefined
  try {
    await copyThrough('0012')
    owned = await createTestDatabase(serverUrl, staging, { tag: 'group_old' })
    await seedEarly(owned.pool)
    await copyThrough('0030')
    await runMigrations(owned.pool, staging)
    await seedLater(owned.pool)
    await copyThrough('0058')
    await runMigrations(owned.pool, staging)
    await seedCurrent(owned.pool)
    for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
    return owned
  } catch (error) {
    await owned?.drop()
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function seedCurrent(pool: pg.Pool) {
  // Fixture ciphertext and hashes are deliberately synthetic. All timestamps stay
  // in PostgreSQL so the preservation assertions retain microsecond precision.
  await pool.query(`DO $$
  DECLARE
    host_id uuid;
    team_id uuid;
    personal_id uuid;
    calendar_id uuid;
    connection_id uuid;
    zoom_id uuid;
    api_id uuid;
    grant_id uuid;
    event_id uuid;
    booking_id uuid;
    entry_id uuid;
    terminal_entry_id uuid;
    cohort_id uuid := gen_random_uuid();
    created timestamptz := '2026-05-06T07:08:09.123456Z';
    changed timestamptz := '2026-06-07T08:09:10.654321Z';
    stamp timestamptz := clock_timestamp();
    message_settings jsonb := '{"reminders":[{"id":"upgrade-before","offsetMinutes":60,"recipients":{"invitee":true,"guests":true,"host":true}}],"followUps":[{"id":"upgrade-after","offsetMinutes":30,"recipients":{"invitee":true,"guests":false,"host":true},"hostNote":"Thanks for meeting.\\n资料已准备好，欢迎查阅。"}]}';
    i integer;
    provider text;
    state text;
  BEGIN
    SELECT p.user_id,p.organization_id INTO host_id,personal_id FROM personal_organizations p LIMIT 1;
    SELECT id INTO team_id FROM auth.organization WHERE slug='upgrade-team';
    SELECT c.id,c.connection_id INTO calendar_id,connection_id FROM calendars c
      JOIN calendar_connections cc ON cc.id=c.connection_id WHERE cc.user_id=host_id AND cc.provider='google' LIMIT 1;
    SELECT id INTO zoom_id FROM conference_connections WHERE user_id=host_id AND mode='meetings' LIMIT 1;
    SELECT id INTO api_id FROM auth.apikey WHERE name='Upgrade agent';
    SELECT id INTO grant_id FROM mcp_oauth_grants LIMIT 1;

    UPDATE event_types SET allowed_durations_minutes=ARRAY[15,30,45,60],notifications=message_settings,
      success_redirect='{"url":"https://example.test/thanks","parameters":["eventTypeSlug"],"includeInviteePersonalData":false,"allowEmbedParent":false}'
      WHERE duration_minutes IN (30,45);
    UPDATE calendars SET sync_state='{"syncToken":"synthetic-current-cursor"}',
      last_synced_at=changed WHERE id=calendar_id;
    INSERT INTO calendar_busy(calendar_id,external_event_id,all_day_start,all_day_end)
      VALUES(calendar_id,'synthetic-all-day','2031-03-09','2031-03-11');
    INSERT INTO conference_token_operations(user_id,operation_id,expires_at)
      VALUES(host_id,gen_random_uuid(),stamp+interval '5 minutes');
    INSERT INTO organization_operations(organization_id,operation,actor_user_id,booking_id,
      source,api_key_id,occurred_at)
      SELECT organization_id,'booking_cancelled',host_id,id,'api',api_id,changed
      FROM bookings WHERE status='cancelled' ORDER BY id LIMIT 1;
    INSERT INTO notification_email_sends(recipient_hash,sent_at) VALUES
      (decode(repeat('ab',32),'hex'),changed),(NULL,created);
    INSERT INTO invitation_email_requests(user_id,organization_id,recipient_hash,requested_at)
      VALUES(host_id,team_id,decode(repeat('cd',32),'hex'),created);
    UPDATE invitation_deliveries SET generation=2,state='sending',attempts=1,
      lease_id=gen_random_uuid(),lease_until=stamp+interval '5 minutes',
      resend_request_id=gen_random_uuid(),authorized_by_user_id=host_id;
    INSERT INTO auth.apikey("configId",name,"referenceId",key,"createdAt","updatedAt",metadata)
      SELECT 'default','Group predecessor '||s.scope,host_id::text,
        'synthetic-group-predecessor-'||s.scope,created,changed,
        json_build_object('scope',s.scope,'organizationId',team_id,'retained','preserve')::text
      FROM (VALUES('read'),('bookings')) s(scope);

    -- Explicit personal and team ordinary bookings, plus true selected-host RR.
    -- Existing seedLater already supplies collective Meet and OAuth attribution.
    FOR i IN 1..3 LOOP
      SELECT id INTO event_id FROM event_types WHERE slug='upgrade-event-'||i;
      IF i=3 THEN SELECT id INTO event_id FROM event_types WHERE scheduling_type='round_robin' LIMIT 1; END IF;
      INSERT INTO bookings(organization_id,event_type_id,start_at,end_at,title,location,
        responses,manage_token_hash,required_host_user_ids,source,api_key_id,
        idempotency_key,idempotency_fingerprint,notification_snapshot,
        ical_version,ical_organizer_name,ical_organizer_email,success_redirect,created_at,updated_at)
        VALUES(CASE WHEN i=1 THEN personal_id ELSE team_id END,event_id,
          '2031-01-01T09:00:00.123456Z'::timestamptz+i*interval '1 day',
          '2031-01-01T09:45:00.123456Z'::timestamptz+i*interval '1 day',
          'Predecessor ordinary '||i,'{"kind":"phone","number":"+15555550100"}',
          '{"purpose":"Historical independent booking 東京"}',
          sha256(convert_to('synthetic-ordinary-manage-'||i,'UTF8')),ARRAY[host_id],
          CASE WHEN i=2 THEN 'api' ELSE 'web' END,CASE WHEN i=2 THEN api_id END,
          'synthetic-ordinary-request-'||i,sha256(convert_to('ordinary-fingerprint-'||i,'UTF8')),
          jsonb_build_object('version',1,'executionMode','configurable','notifications',message_settings),
          2,'Pinned organizer 東京','pinned@example.test',
          '{"url":"https://example.test/previous","parameters":["eventTypeSlug"],"includeInviteePersonalData":false,"allowEmbedParent":false}',
          created,changed) RETURNING id INTO booking_id;
      INSERT INTO booking_hosts(booking_id,user_id) VALUES(booking_id,host_id);
      INSERT INTO booking_attendees(booking_id,name,email,time_zone,locale,is_booker) VALUES
        (booking_id,'Historical booker '||i,'ordinary-'||i||'@example.test','Pacific/Auckland','zh-CN',true),
        (booking_id,'Historical guest '||i,'ordinary-guest-'||i||'@example.test','Asia/Tokyo','ja',false);
      INSERT INTO booking_scheduled_messages(organization_id,booking_id,kind,rule_id,
        anchor_start_at,anchor_end_at,due_at,expires_at,next_attempt_at,attempts,created_at,updated_at)
        SELECT organization_id,id,'follow_up','upgrade-after',start_at,end_at,
          end_at+interval '30 minutes',end_at+interval '1470 minutes',end_at+interval '30 minutes',2,created,changed
          FROM bookings WHERE id=booking_id;
      INSERT INTO booking_notifications(booking_id,kind,message_key,recipient,outcome,suppression_reason,created_at)
        VALUES(booking_id,'follow_up','upgrade-after','host:'||host_id,'suppressed','instance_hourly_limit',changed);
    END LOOP;

    -- Complete provider/state matrix retains independent identity, leases and pins.
    -- Initial data contains ready Meet and ambiguous Zoom; add the four missing cases.
    FOR i IN 1..4 LOOP
      provider := CASE WHEN i<=2 THEN 'google_meet' ELSE 'zoom' END;
      state := CASE WHEN i=2 THEN 'failed' WHEN i=3 THEN 'ready' ELSE 'pending' END;
      SELECT id INTO event_id FROM event_types WHERE slug=CASE WHEN i<=2
        THEN 'upgrade-collective-meet' ELSE 'upgrade-individual-zoom' END;
      INSERT INTO bookings(organization_id,event_type_id,start_at,end_at,title,location,
        required_host_user_ids,hosts_use_default_schedule,manage_token_hash,source,oauth_consent_id,
        idempotency_key,idempotency_fingerprint,created_at,updated_at)
        VALUES(team_id,event_id,'2031-02-01T09:00:00.123456Z'::timestamptz+i*interval '1 day',
          '2031-02-01T09:30:00.123456Z'::timestamptz+i*interval '1 day',
          'Predecessor provider '||i,jsonb_build_object('kind',provider),ARRAY[host_id],false,
          sha256(convert_to('synthetic-provider-manage-'||i,'UTF8')),'mcp',grant_id,
          'synthetic-provider-request-'||i,sha256(convert_to('provider-fingerprint-'||i,'UTF8')),created,changed)
          RETURNING id INTO booking_id;
      INSERT INTO booking_hosts(booking_id,user_id) VALUES(booking_id,host_id);
      INSERT INTO booking_attendees(booking_id,name,email,time_zone,is_booker) VALUES
        (booking_id,'Provider invitee '||i,'provider-'||i||'@example.test','UTC',true);
      INSERT INTO booking_conferences(root_booking_id,organization_id,booking_id,organizer_user_id,
        provider,calendar_id,connection_id,zoom_connection_id,zoom_user_id,zoom_meeting_id,
        revision,applied_revision,state,create_started,external_event_id,error_code,attempts,
        next_attempt_at,lease_id,lease_until,conference_patch_request_id,updated_at,
        invitation_organizer_name,invitation_organizer_email)
        VALUES(booking_id,team_id,booking_id,host_id,provider,
          CASE WHEN i<=2 THEN calendar_id END,CASE WHEN i<=2 THEN connection_id END,
          CASE WHEN i>2 THEN zoom_id END,CASE WHEN i>2 THEN 'synthetic-zoom-meeting-user' END,
          CASE WHEN i=3 THEN '12345678901' END,3,CASE WHEN i=3 THEN 3 END,state,true,
          CASE WHEN i<=2 THEN 'synthetic_current_event_'||i END,
          CASE WHEN i=2 THEN 'ambiguous_create' END,2,changed,
          CASE WHEN state='pending' THEN gen_random_uuid() END,
          CASE WHEN state='pending' THEN stamp+interval '5 minutes' END,
          CASE WHEN i<=2 THEN gen_random_uuid() END,changed,'Provider pinned organizer','provider-organizer@example.test');
      INSERT INTO booking_calendar_targets(root_booking_id,user_id,calendar_id)
        VALUES(booking_id,host_id,calendar_id);
      INSERT INTO booking_calendar_events(booking_id,calendar_id,external_event_id,etag)
        VALUES(booking_id,calendar_id,'synthetic_current_copy_'||i,'synthetic-etag-'||i);
    END LOOP;

    SELECT id INTO event_id FROM event_types WHERE slug='upgrade-event-1';
    UPDATE event_types SET waitlist_enabled=true WHERE id=event_id;
    INSERT INTO waitlist_entries(organization_id,event_type_id,recipient_hash,email,name,
      window_start,window_end,time_zone,locale,consent_version,consented_at,status,verified_at,
      created_at,expires_at,pending_expires_at)
      VALUES(personal_id,event_id,decode(repeat('11',32),'hex'),'waiting@example.test','Waiting 東京',
        stamp+interval '1 day',stamp+interval '5 days','America/Los_Angeles','zh-CN','1',stamp,'notified',stamp,
        stamp,stamp+interval '5 days',stamp+interval '24 hours') RETURNING id INTO entry_id;
    INSERT INTO waitlist_entries(organization_id,event_type_id,recipient_hash,consent_version,
      consented_at,status,terminal_at,terminal_reason,created_at,expires_at,pending_expires_at)
      VALUES(personal_id,event_id,decode(repeat('22',32),'hex'),'1',created,'removed',changed,'invitee_removed',
        created,created+interval '5 days',created+interval '24 hours') RETURNING id INTO terminal_entry_id;
    INSERT INTO waitlist_capabilities(entry_id,purpose,token_hash,expires_at,created_at) VALUES
      (entry_id,'management',decode(repeat('33',32),'hex'),stamp+interval '5 days',stamp),
      (entry_id,'verification',decode(repeat('44',32),'hex'),stamp+interval '1 hour',stamp);
    INSERT INTO waitlist_verification_outbox(entry_id,generation,encrypted_payload,expires_at,
      state,attempts,next_attempt_at,created_at,updated_at)
      VALUES(entry_id,1,decode('abcdef','hex'),stamp+interval '1 hour','pending',1,stamp,stamp,stamp);
    INSERT INTO waitlist_verification_requests(event_type_id,email_hash,ip_hash,generation_id,requested_at)
      VALUES(event_id,decode(repeat('11',32),'hex'),decode(repeat('55',32),'hex'),gen_random_uuid(),stamp);
    INSERT INTO waitlist_key_state(secret_fingerprint,updated_at) VALUES(decode(repeat('66',32),'hex'),changed);
    INSERT INTO waitlist_scan_work(event_type_id,dirty_generation,scanned_generation,next_due_at,updated_at)
      VALUES(event_id,5,3,stamp,changed);
    INSERT INTO waitlist_scan_signals(event_type_id) VALUES(event_id);
    INSERT INTO waitlist_slots(event_type_id,start_at,end_at,is_open,generation,observed_at)
      VALUES(event_id,stamp+interval '2 days',stamp+interval '2 days 30 minutes',true,2,stamp);
    INSERT INTO waitlist_cohorts(id,event_type_id,discovered_at) VALUES(cohort_id,event_id,stamp);
    INSERT INTO waitlist_candidates(cohort_id,entry_id,event_type_id,slots,due_at,expires_at,
      state,attempts,next_attempt_at,created_at,updated_at)
      VALUES(cohort_id,entry_id,event_id,jsonb_build_array(jsonb_build_object('start',stamp+interval '2 days',
        'end',stamp+interval '2 days 30 minutes')),stamp,stamp+interval '1 hour','accepted',2,stamp,stamp,stamp);
    INSERT INTO waitlist_slot_tombstones(event_type_id,recipient_hash,start_at,end_at,outcome,consumed_at,purge_at)
      VALUES(event_id,decode(repeat('11',32),'hex'),stamp+interval '2 days',stamp+interval '2 days 30 minutes',
        'accepted',stamp,stamp+interval '4 days 30 minutes');

    INSERT INTO one_time_booking_links(organization_id,event_type_id,creator_user_id,token_hash,
      prefill_name,prefill_email,expires_at,idempotency_key,idempotency_actor_kind,idempotency_actor_id,created_at,updated_at)
      VALUES(personal_id,event_id,host_id,repeat('a',64),'Active prospect','active@example.test',
        stamp+interval '10 days','synthetic-active-link','api_key',api_id,created,changed);
    INSERT INTO bookings(organization_id,event_type_id,start_at,end_at,title,source,required_host_user_ids)
      VALUES(personal_id,event_id,'2031-04-05T09:00:00.123456Z','2031-04-05T09:30:00.123456Z',
        'Used link booking','web',ARRAY[host_id]) RETURNING id INTO booking_id;
    INSERT INTO booking_hosts(booking_id,user_id) VALUES(booking_id,host_id);
    INSERT INTO booking_attendees(booking_id,name,email,time_zone,is_booker)
      VALUES(booking_id,'Used prospect','used@example.test','UTC',true);
    INSERT INTO one_time_booking_links(organization_id,event_type_id,creator_user_id,token_hash,state,
      booking_id,used_at,idempotency_key,idempotency_actor_kind,idempotency_actor_id,created_at,updated_at)
      VALUES(personal_id,event_id,host_id,repeat('b',64),'used',booking_id,stamp,
        'synthetic-used-link','oauth',grant_id,created,changed);
  END $$`)
}
