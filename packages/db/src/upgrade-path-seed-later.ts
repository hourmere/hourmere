import type pg from 'pg'

/** Exercises data backfills added after 0023, before newer columns can be seeded. */
export async function seedIntermediate(pool: pg.Pool): Promise<void> {
  await pool.query(`DO $$
  DECLARE
    owner_id uuid;
    session_id uuid;
    selected_calendar_id uuid;
    selected_connection_id uuid;
    ready_booking_id uuid;
    failed_booking_id uuid;
    selected_organization_id uuid;
    selected_zoom_id uuid := gen_random_uuid();
    refresh_id uuid := gen_random_uuid();
    token_only_refresh_id uuid := gen_random_uuid();
    stamp timestamptz := '2026-01-02T03:04:05.123456Z';
    changed timestamptz := '2026-04-05T06:07:08.654321Z';
    ciphertext bytea := decode(repeat('a1b2c3d4', 16), 'hex');
  BEGIN
    SELECT c.id, c.connection_id, cc.user_id
      INTO selected_calendar_id, selected_connection_id, owner_id
      FROM calendars c JOIN calendar_connections cc ON cc.id = c.connection_id
      WHERE cc.provider = 'google' AND cc.status = 'active' ORDER BY c.id LIMIT 1;
    UPDATE calendars SET supports_google_meet = true WHERE id = selected_calendar_id;
    SELECT id INTO session_id FROM auth.session WHERE "userId" = owner_id ORDER BY id LIMIT 1;
    SELECT id, organization_id INTO ready_booking_id, selected_organization_id
      FROM bookings WHERE status = 'confirmed' ORDER BY id LIMIT 1;
    SELECT id INTO failed_booking_id FROM bookings
      WHERE status = 'cancelled' AND organization_id = selected_organization_id ORDER BY id LIMIT 1;

    INSERT INTO auth."oauthClient" ("clientId", "userId", "createdAt", "updatedAt", name,
      "redirectUris", "grantTypes", "responseTypes", "requirePKCE", "tokenEndpointAuthMethod") VALUES
      ('upgrade-intermediate-consent', owner_id, stamp, changed, 'Synthetic consent client',
        '["https://consent.example.test/callback"]', '["authorization_code","refresh_token"]', '["code"]', true, 'none'),
      ('upgrade-intermediate-token-only', owner_id, stamp, changed, 'Synthetic retained token client',
        '["https://token.example.test/callback"]', '["authorization_code","refresh_token"]', '["code"]', true, 'none'),
      ('upgrade-intermediate-abandoned', owner_id, stamp, changed, 'Synthetic uncompleted client',
        '["https://abandoned.example.test/callback"]', '["authorization_code","refresh_token"]', '["code"]', true, 'none');
    INSERT INTO auth."oauthConsent" ("clientId", "userId", "referenceId", scopes, "createdAt", "updatedAt")
      VALUES ('upgrade-intermediate-consent', owner_id, selected_organization_id::text,
        '["mcp:tools"]', stamp, changed);
    INSERT INTO auth."oauthRefreshToken" (id, token, "clientId", "sessionId", "userId", "referenceId",
      "expiresAt", "createdAt", revoked, scopes) VALUES
      (refresh_id, 'synthetic-intermediate-refresh', 'upgrade-intermediate-consent', session_id, owner_id,
        selected_organization_id::text, '2027-01-01T00:00:00.123456Z',
        '2026-02-03T04:05:06.234567Z', NULL, '["mcp:tools"]'),
      (token_only_refresh_id, 'synthetic-intermediate-token-only-refresh', 'upgrade-intermediate-token-only',
        NULL, owner_id, selected_organization_id::text, '2027-01-01T00:00:00.123456Z',
        '2026-05-06T07:08:09.345678Z', changed, '["mcp:tools"]');
    INSERT INTO auth."oauthAccessToken" (token, "clientId", "sessionId", "userId", "referenceId",
      "refreshId", "expiresAt", "createdAt", scopes) VALUES
      ('synthetic-intermediate-access', 'upgrade-intermediate-consent', session_id, owner_id,
        selected_organization_id::text, refresh_id, '2027-01-01T00:00:00.123456Z',
        '2026-03-04T05:06:07.456789Z', '["mcp:tools"]'),
      ('synthetic-intermediate-token-only-access', 'upgrade-intermediate-token-only', NULL, owner_id,
        selected_organization_id::text, token_only_refresh_id, '2027-01-01T00:00:00.123456Z',
        '2026-06-07T08:09:10.567891Z', '["mcp:tools"]');

    INSERT INTO conference_connections (id, user_id, provider, external_user_id, account_email,
      display_name, credentials, scopes, status, created_at, updated_at) VALUES
      (selected_zoom_id, owner_id, 'zoom', 'synthetic-intermediate-identity', 'identity@example.test',
        'Synthetic identity before meeting modes', ciphertext, ARRAY['user:read:user'], 'active', stamp, changed),
      (gen_random_uuid(), NULL, 'zoom', NULL, NULL, NULL, NULL, '{}', 'disconnected', stamp, changed);
    INSERT INTO conference_oauth_states (state_hash, user_id, session_id, connection_id, verifier,
      claimed, expires_at, created_at) VALUES
      (repeat('c', 64), owner_id, session_id, selected_zoom_id, ciphertext, false,
        '2027-01-01T00:00:00.123456Z', stamp),
      (repeat('d', 64), owner_id, session_id, NULL, NULL, true,
        '2027-01-01T00:00:00.654321Z', changed);
    INSERT INTO booking_conferences (root_booking_id, organization_id, booking_id, organizer_user_id,
      calendar_id, connection_id, revision, applied_revision, state, request_id, create_started,
      external_event_id, error_code, attempts, next_attempt_at, updated_at,
      invitation_organizer_name, invitation_organizer_email) VALUES
      (ready_booking_id, selected_organization_id, ready_booking_id, owner_id, selected_calendar_id,
        selected_connection_id, 2, 2, 'ready', gen_random_uuid(), true, 'synthetic_intermediate_ready',
        NULL, 3, changed, changed, 'Synthetic organizer snapshot', 'snapshot@example.test'),
      (failed_booking_id, selected_organization_id, failed_booking_id, owner_id, selected_calendar_id,
        selected_connection_id, 1, NULL, 'failed', gen_random_uuid(), true, 'synthetic_intermediate_failed',
        'ambiguous_create', 5, changed, changed, NULL, NULL);
    INSERT INTO booking_conference_notifications (booking_id, kind, due_at, delivered) VALUES
      (ready_booking_id, 'confirmed', stamp, true),
      (ready_booking_id, 'reminder', changed, false),
      (failed_booking_id, 'conference_failed', stamp, false);
  END $$`)
}

/** Adds persisted features introduced between 0013 and the 0030 checkpoint. */
export async function seedLater(pool: pg.Pool): Promise<void> {
  // These byte strings are synthetic encrypted placeholders, never provider credentials.
  // Keep timestamps in SQL so PostgreSQL's microseconds survive the preservation check.
  await pool.query(`DO $$
  DECLARE
    owner_id uuid;
    other_host_id uuid;
    organization_id uuid;
    calendar_id uuid;
    calendar_connection_id uuid;
    session_id uuid := gen_random_uuid();
    client_id text := 'upgrade-path-synthetic-client';
    refresh_id uuid := gen_random_uuid();
    consent_id uuid := gen_random_uuid();
    grant_id uuid := gen_random_uuid();
    zoom_connection_id uuid := gen_random_uuid();
    identity_connection_id uuid := gen_random_uuid();
    meet_event_id uuid := gen_random_uuid();
    zoom_event_id uuid := gen_random_uuid();
    meet_booking_id uuid := gen_random_uuid();
    zoom_booking_id uuid := gen_random_uuid();
    cancelled_booking_id uuid;
    webhook_id uuid := gen_random_uuid();
    disabled_webhook_id uuid := gen_random_uuid();
    stamp timestamptz := '2026-02-03T04:05:06.654321Z';
    created timestamptz := '2026-01-02T03:04:05.123456Z';
    ciphertext bytea := decode(repeat('a1b2c3d4', 16), 'hex');
  BEGIN
    SELECT c.id, c.connection_id, cc.user_id
      INTO calendar_id, calendar_connection_id, owner_id
      FROM calendars c JOIN calendar_connections cc ON cc.id = c.connection_id
      WHERE cc.provider = 'google' AND cc.status = 'active' ORDER BY c.id LIMIT 1;
    UPDATE calendars SET supports_google_meet = true WHERE id = calendar_id;
    SELECT id INTO other_host_id FROM auth."user" WHERE id <> owner_id ORDER BY id LIMIT 1;
    SELECT o.id INTO organization_id FROM auth.organization o
      WHERE NOT EXISTS (SELECT 1 FROM personal_organizations p WHERE p.organization_id = o.id)
      ORDER BY o.id LIMIT 1;
    SELECT id INTO cancelled_booking_id FROM bookings WHERE status = 'cancelled' ORDER BY id LIMIT 1;

    INSERT INTO sign_in_emails (id, encrypted_payload, expires_at, created_at) VALUES
      (gen_random_uuid(), ciphertext, '2026-10-20T00:00:00.123456Z', created),
      (gen_random_uuid(), ciphertext || decode('ff', 'hex'), '2026-10-21T00:00:00.654321Z', stamp);
    UPDATE event_types SET allow_guests = true WHERE id = (SELECT id FROM event_types ORDER BY id LIMIT 1);
    INSERT INTO round_robin_state (event_type_id, next_sequence, enabled)
      SELECT id, 17, true FROM event_types WHERE scheduling_type = 'round_robin' ORDER BY id LIMIT 1;

    INSERT INTO auth.session (id, "expiresAt", token, "createdAt", "updatedAt", "userId", "activeOrganizationId")
      VALUES (session_id, '2027-01-01T00:00:00.123456Z', 'synthetic-upgrade-later-session',
        created, stamp, owner_id, organization_id::text);
    INSERT INTO auth.jwks ("publicKey", "privateKey", "createdAt", "expiresAt", alg, crv)
      VALUES ('{"kty":"RSA","kid":"synthetic-upgrade-key"}',
        'synthetic-encrypted-private-key', created, '2027-01-01T00:00:00.654321Z', 'RS256', NULL);
    INSERT INTO auth."oauthClient" ("clientId", "clientSecret", disabled, "skipConsent", scopes,
      "userId", "createdAt", "updatedAt", name, uri, contacts, "redirectUris",
      "tokenEndpointAuthMethod", "applicationType", "grantTypes", "responseTypes", "requirePKCE", metadata)
      VALUES (client_id, 'synthetic-hashed-client-secret', false, false, '["mcp:tools"]',
        owner_id, created, stamp, 'Synthetic upgrade MCP connector', 'https://connector.example.test',
        '["operator@example.test"]', '["https://connector.example.test/callback"]',
        'none', 'web', '["authorization_code","refresh_token"]', '["code"]', true,
        '{"registration":"dynamic","purpose":"upgrade fixture"}');
    INSERT INTO auth."oauthResource" (identifier, name, "accessTokenTtl", "refreshTokenTtl",
      "allowedScopes", "createdAt", "updatedAt", metadata)
      VALUES ('https://hourmere.example.test/mcp', 'Synthetic Hourmere MCP', 3600, 86400,
        '["mcp:tools"]', created, stamp, '{"fixture":true}');
    INSERT INTO auth."oauthClientResource" ("clientId", "resourceId", metadata, "createdAt")
      VALUES (client_id, 'https://hourmere.example.test/mcp', '{"approved":true}', created);
    INSERT INTO auth."oauthRefreshToken" (id, token, "clientId", "sessionId", "userId", "referenceId",
      resources, "expiresAt", "createdAt", "rotatedAt", "authTime", scopes)
      VALUES (refresh_id, 'synthetic-hashed-upgrade-refresh', client_id, session_id, owner_id,
        grant_id::text, '["https://hourmere.example.test/mcp"]',
        '2027-01-02T03:04:05.123456Z', created, stamp, created, '["mcp:tools"]');
    INSERT INTO auth."oauthAccessToken" (token, "clientId", "sessionId", "userId", "referenceId",
      resources, "refreshId", "expiresAt", "createdAt", scopes)
      VALUES ('synthetic-hashed-upgrade-access', client_id, session_id, owner_id, grant_id::text,
        '["https://hourmere.example.test/mcp"]', refresh_id, '2026-10-20T03:04:05.123456Z', stamp,
        '["mcp:tools"]');
    INSERT INTO auth."oauthConsent" (id, "clientId", "userId", "referenceId", resources,
      scopes, "createdAt", "updatedAt")
      VALUES (consent_id, client_id, owner_id, grant_id::text,
        '["https://hourmere.example.test/mcp"]', '["mcp:tools"]', created, stamp);
    INSERT INTO auth."oauthClientAssertion" ("expiresAt") VALUES ('2026-10-20T00:00:00.123456Z');
    INSERT INTO mcp_oauth_grants (id, user_id, organization_id, client_id, created_at)
      VALUES (grant_id, owner_id, organization_id, client_id, created);
    INSERT INTO mcp_oauth_intents (user_id, session_id, grant_id, organization_id,
      request_hash, expires_at, used_at, created_at)
      VALUES (owner_id, session_id, grant_id, organization_id, sha256(convert_to('synthetic-request', 'UTF8')),
        '2026-10-20T00:00:00.123456Z', stamp, created);
    INSERT INTO mcp_oauth_client_activity (client_id, consented_at, last_used_at)
      VALUES (client_id, created, stamp);

    INSERT INTO conference_connections (id, user_id, provider, external_user_id, account_email,
      display_name, credentials, scopes, status, mode, created_at, updated_at) VALUES
      (zoom_connection_id, owner_id, 'zoom', 'synthetic-zoom-meeting-user', 'zoom@example.test',
        'Synthetic Zoom meeting account', ciphertext,
        ARRAY['user:read:user','meeting:write:meeting','meeting:read:meeting','meeting:update:meeting','meeting:delete:meeting'],
        'active', 'meetings', created, stamp),
      (identity_connection_id, other_host_id, 'zoom', 'synthetic-zoom-identity-user', 'identity@example.test',
        'Synthetic Zoom identity account', ciphertext, ARRAY['user:read:user'], 'active', 'identity', created, stamp),
      (gen_random_uuid(), NULL, 'zoom', NULL, NULL, NULL, NULL, '{}', 'disconnected', 'identity', created, stamp);
    INSERT INTO conference_oauth_states (state_hash, user_id, session_id, connection_id, verifier,
      claimed, expires_at, created_at, mode, binding_version) VALUES
      (repeat('a', 64), owner_id, session_id, zoom_connection_id, ciphertext, false,
        '2026-10-20T00:00:00.123456Z', created, 'meetings', 2),
      (repeat('b', 64), owner_id, session_id, NULL, NULL, true,
        '2026-10-20T00:00:00.654321Z', stamp, 'identity', 1);

    INSERT INTO event_types (id, organization_id, slug, title, description, duration_minutes,
      scheduling_type, location, is_hidden, allow_guests, conference_organizer_user_id,
      zoom_connection_id, created_at, updated_at) VALUES
      (meet_event_id, organization_id, 'upgrade-collective-meet', 'Upgrade collective Meet',
        'Synthetic later installation with an explicit organizer', 45, 'collective',
        '{"kind":"google_meet","autoCreate":true}', true, true, owner_id, NULL, created, stamp),
      (zoom_event_id, organization_id, 'upgrade-individual-zoom', 'Upgrade individual Zoom',
        'Synthetic later installation with a pinned conference account', 30, 'individual',
        '{"kind":"zoom","autoCreate":true}', false, false, NULL, zoom_connection_id, created, stamp);
    INSERT INTO event_type_hosts (event_type_id, user_id, weight, last_assigned_sequence) VALUES
      (meet_event_id, owner_id, 100, 3), (meet_event_id, other_host_id, 100, 7),
      (zoom_event_id, owner_id, 100, 11);
    INSERT INTO bookings (id, organization_id, event_type_id, start_at, end_at, title,
      location, responses, manage_token_hash, source, oauth_consent_id, idempotency_key,
      idempotency_fingerprint, required_host_user_ids, hosts_use_default_schedule, created_at, updated_at) VALUES
      (meet_booking_id, organization_id, meet_event_id, '2028-04-05T09:00:00.123456Z',
        '2028-04-05T09:45:00.123456Z', 'Upgrade collective Meet',
        '{"kind":"google_meet","url":"https://meet.example.test/synthetic"}', '{"purpose":"preserve later fields"}',
        sha256(convert_to('synthetic-later-meet-manage', 'UTF8')), 'mcp', grant_id,
        'synthetic-later-mcp-idempotency', sha256(convert_to('synthetic-mcp-request', 'UTF8')),
        ARRAY(SELECT u FROM unnest(ARRAY[owner_id, other_host_id]) u ORDER BY u), true, created, stamp),
      (zoom_booking_id, organization_id, zoom_event_id, '2028-04-06T10:00:00.654321Z',
        '2028-04-06T10:30:00.654321Z', 'Upgrade individual Zoom', '{"kind":"zoom","autoCreate":true}', '{}',
        sha256(convert_to('synthetic-later-zoom-manage', 'UTF8')), 'web', NULL,
        NULL, NULL, ARRAY[owner_id], false, created, stamp);
    INSERT INTO booking_hosts (booking_id, user_id) VALUES
      (meet_booking_id, owner_id), (meet_booking_id, other_host_id), (zoom_booking_id, owner_id);
    INSERT INTO booking_attendees (booking_id, name, email, time_zone, locale, is_booker) VALUES
      (meet_booking_id, 'Later MCP invitee', 'later-mcp@example.test', 'Europe/Berlin', 'en', true),
      (meet_booking_id, 'Later MCP guest', 'later-guest@example.test', 'Asia/Tokyo', 'ja', false),
      (zoom_booking_id, 'Later Zoom invitee', 'later-zoom@example.test', 'America/Los_Angeles', 'en', true);
    INSERT INTO booking_conferences (root_booking_id, organization_id, booking_id, organizer_user_id,
      calendar_id, connection_id, revision, applied_revision, state, request_id, create_started,
      external_event_id, error_code, attempts, next_attempt_at, updated_at,
      invitation_organizer_name, invitation_organizer_email, provider, zoom_connection_id, zoom_user_id) VALUES
      (meet_booking_id, organization_id, meet_booking_id, owner_id, calendar_id, calendar_connection_id,
        1, 1, 'ready', gen_random_uuid(), true, 'synthetic_meet_event', NULL, 2, stamp, stamp,
        'Synthetic organizer', 'organizer@example.test', 'google_meet', NULL, NULL),
      (zoom_booking_id, organization_id, zoom_booking_id, owner_id, NULL, NULL,
        0, NULL, 'failed', gen_random_uuid(), true, NULL, 'ambiguous_create', 4, stamp, stamp,
        'Synthetic organizer', 'organizer@example.test', 'zoom', zoom_connection_id, 'synthetic-zoom-meeting-user');
    INSERT INTO booking_conference_mirrors (root_booking_id, user_id, calendar_id, connection_id,
      operation_id, revision, applied_revision, state, error_code, create_started, external_event_id,
      attempts, next_attempt_at, updated_at) VALUES
      (meet_booking_id, other_host_id, NULL, NULL, gen_random_uuid(), 1, NULL, 'not_configured',
        'not_configured', false, NULL, 0, stamp, stamp),
      (zoom_booking_id, owner_id, calendar_id, calendar_connection_id, gen_random_uuid(), 0, 0, 'ready',
        NULL, true, 'synthetic_zoom_calendar_copy', 1, stamp, stamp);
    INSERT INTO booking_conference_notifications (booking_id, kind, due_at, delivered, attempts,
      lease_id, lease_until, last_error, exhausted_at, skipped_at) VALUES
      (meet_booking_id, 'confirmed', stamp, true, 1, NULL, NULL, NULL, NULL, NULL),
      (meet_booking_id, 'reminder', '2028-04-05T08:00:00.123456Z', false, 2,
        gen_random_uuid(), '2028-04-05T08:01:00.654321Z', 'recipient_retry', NULL, NULL),
      (zoom_booking_id, 'conference_failed', stamp, false, 13, NULL, NULL, 'delivery_failed', stamp, NULL),
      (zoom_booking_id, 'confirmed', created, false, 0, NULL, NULL, NULL, NULL, stamp);

    INSERT INTO webhooks (id, organization_id, url, events, is_active, secret_ciphertext, created_at, updated_at) VALUES
      (webhook_id, organization_id, 'https://webhook.example.test/booking',
        ARRAY['booking.created','booking.rescheduled','booking.cancelled'], true, ciphertext, created, stamp),
      (disabled_webhook_id, organization_id, 'https://webhook.example.test/disabled',
        ARRAY['booking.cancelled'], false, ciphertext || decode('ab', 'hex'), created, stamp);
    INSERT INTO webhook_deliveries (webhook_id, organization_id, booking_id, event_id, event_type,
      payload, status, attempts, http_status, last_error, created_at, last_attempt_at, delivered_at) VALUES
      (webhook_id, organization_id, meet_booking_id, gen_random_uuid(), 'booking.created',
        '{"fixture":"delivered","type":"booking.created"}', 'delivered', 2, 204, NULL, created, stamp, stamp),
      (webhook_id, organization_id, zoom_booking_id, gen_random_uuid(), 'booking.created',
        '{"fixture":"interrupted","type":"booking.created"}', 'pending', 1, NULL, 'interrupted', created, stamp, NULL),
      (disabled_webhook_id, organization_id, cancelled_booking_id, gen_random_uuid(), 'booking.cancelled',
        '{"fixture":"failed","type":"booking.cancelled"}', 'failed', 13, 503, 'job_missing', created, stamp, NULL);
  END $$`)
}
