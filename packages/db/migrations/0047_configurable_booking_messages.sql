-- Settings are copied into each new booking. A NULL snapshot is an immutable
-- legacy default marker, never an instruction to reread the event type.
CREATE FUNCTION valid_booking_message_settings(settings jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  rules jsonb;
  rule jsonb;
  recipients jsonb;
BEGIN
  IF jsonb_typeof(settings) IS DISTINCT FROM 'object'
    OR jsonb_typeof(settings->'reminders') IS DISTINCT FROM 'array'
    OR jsonb_typeof(settings->'followUps') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(settings->'reminders') > 5
    OR jsonb_array_length(settings->'followUps') > 3 THEN RETURN false; END IF;
  rules := (settings->'reminders') || (settings->'followUps');
  FOR rule IN SELECT value FROM jsonb_array_elements(rules) LOOP
    recipients := rule->'recipients';
    IF jsonb_typeof(rule) IS DISTINCT FROM 'object'
      OR jsonb_typeof(rule->'id') IS DISTINCT FROM 'string'
      OR NOT ((rule->>'id') ~ '^[A-Za-z0-9_-]{1,64}$')
      OR rule->>'id' = '__proto__'
      OR jsonb_typeof(rule->'offsetMinutes') IS DISTINCT FROM 'number'
      OR jsonb_typeof(recipients) IS DISTINCT FROM 'object'
      OR jsonb_typeof(recipients->'invitee') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(recipients->'guests') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(recipients->'host') IS DISTINCT FROM 'boolean' THEN
      RETURN false;
    END IF;
    IF (rule->>'offsetMinutes')::numeric NOT BETWEEN 5 AND 43200
      OR (rule->>'offsetMinutes')::numeric <> trunc((rule->>'offsetMinutes')::numeric)
      OR NOT ((recipients->>'invitee')::boolean OR (recipients->>'guests')::boolean
        OR (recipients->>'host')::boolean) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

ALTER TABLE event_types
  ADD COLUMN notifications jsonb NOT NULL DEFAULT
    '{"reminders":[{"id":"default-24h","offsetMinutes":1440,"recipients":{"invitee":true,"guests":true,"host":true}}],"followUps":[]}',
  ADD CONSTRAINT event_types_notifications_check CHECK (valid_booking_message_settings(notifications));

ALTER TABLE bookings
  ADD COLUMN notification_snapshot jsonb,
  ADD CONSTRAINT bookings_notification_snapshot_check CHECK (
    notification_snapshot IS NULL OR (
      jsonb_typeof(notification_snapshot) = 'object'
      AND notification_snapshot->'version' = '1'::jsonb
      AND notification_snapshot->>'executionMode' IN ('legacy_default','configurable')
      AND notification_snapshot ? 'notifications'
      AND valid_booking_message_settings(notification_snapshot->'notifications')
    ) IS TRUE
  ),
  ADD CONSTRAINT bookings_id_organization_unique UNIQUE (id,organization_id);

CREATE TABLE booking_scheduled_messages (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reminder','follow_up')),
  rule_id text NOT NULL CHECK (rule_id ~ '^[A-Za-z0-9_-]{1,64}$' AND rule_id <> '__proto__'),
  anchor_start_at timestamptz NOT NULL,
  anchor_end_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','processing','completed','skipped','failed')),
  skip_reason text CHECK (skip_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 13),
  next_attempt_at timestamptz NOT NULL,
  claim_token uuid,
  lease_until timestamptz,
  last_job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id,kind,rule_id),
  FOREIGN KEY (booking_id,organization_id) REFERENCES bookings(id,organization_id) ON DELETE CASCADE,
  CHECK (anchor_end_at > anchor_start_at),
  CHECK (expires_at > due_at),
  CHECK (
    (state='processing' AND claim_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state<>'processing' AND claim_token IS NULL AND lease_until IS NULL)
  )
);
CREATE INDEX booking_scheduled_messages_repair ON booking_scheduled_messages(next_attempt_at,id)
  WHERE state IN ('pending','processing');
CREATE INDEX booking_scheduled_messages_booking ON booking_scheduled_messages(booking_id);
CREATE TRIGGER booking_scheduled_messages_updated_at BEFORE UPDATE ON booking_scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Metadata-only defaults preserve every historical receipt and capability hash.
-- Never reseed the mail-budget ledger or manufacture jobs for old bookings here.
ALTER TABLE booking_notifications
  ADD COLUMN message_key text NOT NULL DEFAULT '',
  DROP CONSTRAINT booking_notifications_pkey,
  ADD PRIMARY KEY (booking_id,kind,message_key,recipient),
  DROP CONSTRAINT booking_notifications_kind_check,
  ADD CONSTRAINT booking_notifications_kind_check
    CHECK (kind IN ('confirmed','rescheduled','cancelled','reminder','conference_failed','follow_up')),
  ADD CONSTRAINT booking_notifications_message_key_check CHECK (
    message_key = '' OR (kind IN ('reminder','follow_up')
      AND message_key ~ '^[A-Za-z0-9_-]{1,64}$' AND message_key <> '__proto__')
  );
