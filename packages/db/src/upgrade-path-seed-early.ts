import type pg from 'pg'

/** Uses only columns available through 0012; no current application write helpers. */
export async function seedEarly(pool: pg.Pool) {
  await pool.query(`
    DO $$
    DECLARE
      users uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
      personal uuid := gen_random_uuid();
      team uuid := gen_random_uuid();
      session_id uuid;
      connection_id uuid;
      calendar_id uuid;
      destination uuid;
      schedule_id uuid;
      event_id uuid;
      events uuid[] := '{}';
      booking_id uuid;
      predecessor uuid;
      attendee_id uuid;
      api_key uuid := gen_random_uuid();
      stamp timestamptz := '2026-01-02T03:04:05.123456Z';
      changed timestamptz := '2026-02-03T04:05:06.654321Z';
      i integer;
      j integer;
    BEGIN
      FOR i IN 1..3 LOOP
        INSERT INTO auth."user" (id,name,email,"emailVerified",image,"createdAt","updatedAt")
          VALUES (users[i],(ARRAY['Ada 東京','Grace Hopper','Katherine Johnson'])[i],
            'upgrade-host-' || i || '@example.test',true,'https://example.test/avatar',stamp,changed);
        INSERT INTO auth.account ("accountId","providerId","userId","accessToken","refreshToken",
          "idToken","accessTokenExpiresAt","refreshTokenExpiresAt",scope,password,"createdAt","updatedAt")
          VALUES ('synthetic-identity-' || i,(ARRAY['google','microsoft','credential'])[i],users[i],
            'synthetic-encrypted-access-' || i,'synthetic-encrypted-refresh-' || i,
            CASE WHEN i < 3 THEN 'synthetic-retained-id-token-' || i END,
            stamp + interval '1 year',stamp + interval '2 years','openid email profile',
            CASE WHEN i = 3 THEN 'synthetic-password-hash' END,stamp,changed);
        INSERT INTO auth.session ("userId",token,"expiresAt","updatedAt","createdAt","ipAddress","userAgent")
          VALUES (users[i],'synthetic-session-' || i,stamp + interval '10 years',changed,stamp,
            '192.0.2.' || i,'Synthetic upgrade fixture') RETURNING id INTO session_id;
        IF i < 3 THEN
          INSERT INTO calendar_connections (user_id,provider,external_account_id,account_email,
            credentials,scopes,status,last_error,created_at,updated_at)
            VALUES (users[i],(ARRAY['google','microsoft'])[i],'synthetic-account-' || i,
              'calendar-' || i || '@example.test',decode(repeat('a1b2c3d4',12),'hex'),
              ARRAY['calendar.readonly','calendar.events'],CASE WHEN i=1 THEN 'active' ELSE 'needs_reauth' END,
              CASE WHEN i=2 THEN 'synthetic safe error' END,stamp,changed) RETURNING id INTO connection_id;
          INSERT INTO calendars (connection_id,external_id,name,is_primary,check_conflicts,sync_state,
            last_synced_at,access_role,time_zone,sync_error)
            VALUES (connection_id,'synthetic-calendar-' || i,'Work 東京 ' || i,true,i=1,
              '{"syncToken":"synthetic-cursor","channel":"synthetic-channel"}',changed,
              'writer','America/Los_Angeles',CASE WHEN i=2 THEN 'needs_reauth' END)
            RETURNING id INTO calendar_id;
          INSERT INTO calendar_busy VALUES (calendar_id,'synthetic-busy-' || i,
            tstzrange('2030-06-01T09:00Z','2030-06-01T10:00Z','[)'));
          INSERT INTO calendar_oauth_states (state_hash,user_id,session_id,verifier,expires_at,
            created_at,access,provider)
            VALUES (repeat(i::text,64),users[i],session_id,decode(repeat('d4c3b2a1',12),'hex'),
              stamp + interval '10 years',stamp,'sync',(ARRAY['google','microsoft'])[i]);
          IF i=1 THEN destination := calendar_id; END IF;
        ELSE
          calendar_id := NULL;
        END IF;
        INSERT INTO profiles (user_id,handle,time_zone,locale,destination_calendar_id,created_at,updated_at)
          VALUES (users[i],'upgrade-host-' || i,'America/Los_Angeles','en',calendar_id,stamp,changed);
        INSERT INTO schedules (user_id,name,time_zone,weekly_hours,is_default,created_at,updated_at)
          VALUES (users[i],'Working hours ' || i,'America/Los_Angeles',
            '{"monday":[{"start":"09:00","end":"12:00"},{"start":"13:00","end":"17:00"}],"sunday":[]}',
            true,stamp,changed) RETURNING id INTO schedule_id;
        INSERT INTO schedule_overrides VALUES (schedule_id,'2030-12-25','[]'),
          (schedule_id,'2030-12-24','[{"start":"09:00","end":"12:00"}]');
      END LOOP;
      INSERT INTO auth.verification (identifier,value,"expiresAt","createdAt","updatedAt")
        VALUES ('synthetic-verification','synthetic-hashed-verification',stamp + interval '10 years',stamp,changed);
      INSERT INTO auth.organization (id,name,slug,metadata,"createdAt") VALUES
        (personal,'Ada personal','upgrade-personal','{"kind":"personal"}',stamp),
        (team,'Upgrade team 東京','upgrade-team','{"department":"engineering"}',stamp);
      INSERT INTO personal_organizations VALUES (users[1],personal);
      INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
        VALUES (personal,users[1],'owner',stamp),(team,users[1],'owner',stamp),
          (team,users[2],'admin',stamp),(team,users[3],'member',stamp);
      INSERT INTO auth.invitation ("organizationId",email,role,status,"expiresAt","createdAt","inviterId")
        VALUES (team,'upgrade-invitee@example.test','member','pending',stamp + interval '10 years',stamp,users[1]);
      INSERT INTO auth.apikey (id,"configId",name,start,"referenceId",prefix,key,enabled,
        "rateLimitEnabled","rateLimitTimeWindow","rateLimitMax","requestCount",remaining,
        "createdAt","updatedAt",permissions,metadata)
        VALUES (api_key,'default','Upgrade agent','hm_fixture',users[1]::text,'hm_',
          'synthetic-hashed-api-key',true,true,60000,600,7,593,stamp,changed,
          '{"bookings":["read","write"]}',json_build_object('organizationId',team)::text),
          (gen_random_uuid(),'default','Disabled agent','hm_disabled',users[2]::text,'hm_',
          'synthetic-disabled-api-key',false,true,60000,600,0,600,stamp,changed,'{}',
          json_build_object('organizationId',team)::text);
      FOR i IN 1..5 LOOP
        INSERT INTO event_types (organization_id,owner_user_id,slug,title,description,duration_minutes,
          slot_step_minutes,buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,
          booking_window_days,max_bookings_per_day,scheduling_type,location,questions,is_active,
          position,created_at,updated_at,deleted_at)
          VALUES (CASE WHEN i=1 THEN personal ELSE team END,CASE WHEN i=1 THEN users[1] END,
            'upgrade-event-' || i,'Upgrade event 東京 ' || i,E'Historical description\nsecond line',30,
            15,5,10,60,90,12,(ARRAY['individual','individual','collective','round_robin','individual'])[i],
            '{"kind":"phone","number":"+15555550100"}',
            '[{"id":"purpose","label":"Purpose","type":"long_text","required":true}]',
            i<>5,i,stamp,changed,CASE WHEN i=5 THEN changed END) RETURNING id INTO event_id;
        events := array_append(events,event_id);
        FOR j IN 1..(CASE WHEN i IN (3,4) THEN 2 ELSE 1 END) LOOP
          INSERT INTO event_type_hosts (event_type_id,user_id,schedule_id,destination_calendar_id,weight)
            SELECT event_id,users[j],s.id,CASE WHEN j=1 THEN destination END,100
            FROM schedules s WHERE s.user_id=users[j];
        END LOOP;
      END LOOP;
      FOR i IN 1..6 LOOP
        INSERT INTO bookings (organization_id,event_type_id,status,start_at,end_at,title,location,
          responses,manage_token_hash,rescheduled_from_id,cancelled_at,cancel_reason,source,
          api_key_id,idempotency_key,idempotency_fingerprint,created_at,updated_at,
          cancelled_source,cancelled_api_key_id)
          VALUES (team,events[3],CASE WHEN i IN (1,2,4,6) THEN 'cancelled' ELSE 'confirmed' END,
            '2030-07-01T10:00:00.123456Z'::timestamptz + i * interval '1 day',
            '2030-07-01T10:30:00.654321Z'::timestamptz + i * interval '1 day',
            'Upgrade booking ' || i,'{"kind":"phone","number":"+15555550100"}',
            '{"purpose":"Preserve 東京, quotes and historical answers"}',
            sha256(convert_to('synthetic-manage-' || i,'UTF8')),CASE WHEN i IN (2,3) THEN predecessor END,
            CASE WHEN i IN (1,2,4,6) THEN changed END,CASE WHEN i IN (1,2,4,6) THEN 'Historical withdrawal' END,
            (ARRAY['web','api','mcp','embed','api','web'])[i],CASE WHEN i IN (2,3,5) THEN api_key END,
            'synthetic-idempotency-' || i,sha256(convert_to('synthetic-request-' || i,'UTF8')),stamp,changed,
            CASE WHEN i=4 THEN 'api' END,CASE WHEN i=4 THEN api_key END) RETURNING id INTO booking_id;
        IF i<3 THEN predecessor := booking_id; END IF;
        IF i<>6 THEN
          INSERT INTO booking_hosts (booking_id,user_id) VALUES (booking_id,users[1]);
          IF i IN (1,2,3) THEN
            INSERT INTO booking_hosts (booking_id,user_id) VALUES (booking_id,users[2]);
          END IF;
        END IF;
        INSERT INTO booking_attendees (booking_id,name,email,time_zone,locale,is_booker)
          VALUES (booking_id,'Synthetic Booker','booker@example.test','Europe/Berlin','de',true)
          RETURNING id INTO attendee_id;
        INSERT INTO booking_attendees (booking_id,name,email,time_zone,locale,is_booker)
          VALUES (booking_id,'Historical Guest 東京','guest@example.test','Asia/Tokyo','ja',false);
        INSERT INTO booking_notifications (booking_id,kind,recipient,manage_token_hash,outcome,created_at)
          VALUES (booking_id,'confirmed','attendee:' || attendee_id,
            sha256(convert_to('synthetic-email-manage-' || i,'UTF8')),'sent',stamp),
            (booking_id,'reminder','host:' || users[1],NULL,'rejected',changed);
        INSERT INTO booking_calendar_events VALUES (booking_id,destination,'synthetic-provider-event-' || i,'synthetic-etag-' || i);
        IF i NOT IN (2,3) THEN
          INSERT INTO booking_calendar_targets VALUES (booking_id,users[1],destination);
        END IF;
      END LOOP;
    END $$;
  `)
}
