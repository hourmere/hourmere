-- Settings are copied into each new booking. A NULL snapshot is an immutable
-- legacy default marker, never an instruction to reread the event type.
CREATE OR REPLACE FUNCTION valid_booking_message_settings(settings jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  rules jsonb;
  rule jsonb;
  recipients jsonb;
  note text;
  note_units bigint;
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

  -- Only follow-ups may carry a host-authored plain-text body. No rewriting:
  -- historical policies, booking snapshots and scheduled mail remain untouched.
  FOR rule IN SELECT value FROM jsonb_array_elements(settings->'reminders') LOOP
    IF rule ? 'hostNote' THEN RETURN false; END IF;
  END LOOP;
  FOR rule IN SELECT value FROM jsonb_array_elements(settings->'followUps') LOOP
    IF rule ? 'hostNote' THEN
      IF jsonb_typeof(rule->'hostNote') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      note := rule->>'hostNote';
      -- PostgreSQL text/JSON already rejects NUL and malformed Unicode. Permit
      -- tab, CR and LF; reject other C0/C1 and bidi embedding/isolate controls.
      IF note ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F-\009F\202A-\202E\2066-\2069]' THEN RETURN false; END IF;
      -- Match JavaScript string.length: a supplementary scalar occupies two
      -- UTF-16 code units. UTF-8 scalars with four bytes are supplementary.
      SELECT coalesce(sum(CASE WHEN octet_length(scalar) = 4 THEN 2 ELSE 1 END),0)
        INTO note_units FROM regexp_split_to_table(note,'') AS scalar;
      IF note_units > 2000 THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END $$;
