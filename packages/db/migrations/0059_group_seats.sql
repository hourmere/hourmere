-- A group slot owns one host occupancy; every invitee remains an independent booking.
-- This is storage only. Public creation and resource workers must not enable group mode
-- until the follow-on service/projection/integration work is deployed (see sidecar).
-- Match ECMAScript String.trim() for this private duplicate-mailbox key. SQL's
-- one-argument btrim only removes ASCII space and would leave tab/Unicode aliases.
CREATE FUNCTION normalize_group_booker_key(mailbox text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT lower(btrim(mailbox,
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'));
$$;

ALTER TABLE event_types
  ADD COLUMN booking_mode text NOT NULL DEFAULT 'individual',
  ADD COLUMN group_capacity integer,
  ADD CONSTRAINT event_types_booking_mode CHECK (booking_mode IN ('individual','group')),
  ADD CONSTRAINT event_types_group_capacity CHECK (
    (booking_mode='individual' AND group_capacity IS NULL) OR
    (booking_mode='group' AND group_capacity BETWEEN 2 AND 100 AND group_capacity IS NOT NULL
      AND scheduling_type='individual' AND NOT allow_guests)
  );

CREATE TABLE group_slots (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  event_type_id uuid,
  -- Identity/config snapshots deliberately have no live user/schedule/provider FKs.
  original_event_type_id uuid NOT NULL,
  host_user_id uuid NOT NULL,
  host_schedule_id uuid,
  host_schedule_uses_default boolean NOT NULL DEFAULT true,
  host_time_zone text NOT NULL DEFAULT 'UTC',
  organizer_user_id uuid,
  destination_calendar_id uuid,
  conference_organizer_user_id uuid,
  zoom_connection_id uuid,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  capacity integer NOT NULL CHECK (capacity BETWEEN 2 AND 100),
  active_seats integer NOT NULL DEFAULT 0 CHECK (active_seats BETWEEN 0 AND capacity),
  -- The terminal state also records cause: final seat exit versus explicit host cancellation.
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','retired','host_cancelled')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  count_revision bigint NOT NULL DEFAULT 1 CHECK (count_revision > 0),
  logistics_revision bigint NOT NULL DEFAULT 1 CHECK (logistics_revision > 0),
  title text NOT NULL,
  location jsonb,
  buffer_before_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 1440),
  buffer_after_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 1440),
  host_notification_settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK ((host_schedule_id IS NULL) = host_schedule_uses_default),
  UNIQUE (id,organization_id),
  FOREIGN KEY (event_type_id,organization_id) REFERENCES event_types(id,organization_id)
    ON DELETE SET NULL (event_type_id)
);
CREATE UNIQUE INDEX group_slots_open_tuple ON group_slots
  (organization_id,original_event_type_id,host_user_id,start_at,end_at) WHERE state='open';
CREATE INDEX group_slots_event_interval ON group_slots(original_event_type_id,start_at,end_at,state);
CREATE INDEX group_slots_organization_start ON group_slots(organization_id,start_at,id);
CREATE INDEX group_slots_host_start ON group_slots(host_user_id,start_at,id);
CREATE INDEX group_slots_terminal_cleanup ON group_slots(end_at,id) WHERE state<>'open';
CREATE TRIGGER group_slots_updated_at BEFORE UPDATE ON group_slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE bookings
  ADD COLUMN group_slot_id uuid,
  ADD COLUMN group_booker_key text,
  ADD CONSTRAINT bookings_group_slot_fkey FOREIGN KEY (group_slot_id,organization_id)
    REFERENCES group_slots(id,organization_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT bookings_group_booker_shape CHECK (
    (group_slot_id IS NULL AND group_booker_key IS NULL) OR
    (group_slot_id IS NOT NULL AND group_booker_key IS NOT NULL
      AND group_booker_key<>'' AND group_booker_key=normalize_group_booker_key(group_booker_key))
  );
CREATE UNIQUE INDEX bookings_group_active_mailbox ON bookings(group_slot_id,group_booker_key)
  WHERE group_slot_id IS NOT NULL AND status='confirmed';
CREATE INDEX bookings_group_roster ON bookings(group_slot_id,start_at,id);

ALTER TABLE booking_hosts
  DROP CONSTRAINT booking_hosts_pkey,
  ALTER COLUMN booking_id DROP NOT NULL,
  ADD COLUMN id uuid NOT NULL DEFAULT uuidv7(),
  ADD COLUMN group_slot_id uuid REFERENCES group_slots(id) ON DELETE CASCADE,
  ADD PRIMARY KEY (id),
  ADD CONSTRAINT booking_hosts_parent CHECK ((booking_id IS NULL)<>(group_slot_id IS NULL));
CREATE UNIQUE INDEX booking_hosts_booking_user ON booking_hosts(booking_id,user_id)
  WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX booking_hosts_group_user ON booking_hosts(group_slot_id,user_id)
  WHERE group_slot_id IS NOT NULL;
-- booking_hosts_no_overlap is intentionally untouched: user_id WITH =, period WITH &&,
-- WHERE (active), across both kinds of parent and every organization.
CREATE OR REPLACE FUNCTION booking_host_slot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE parent_host uuid; seat_slot uuid;
BEGIN
  -- Preserve the legacy missing-booking-parent diagnostic when neither parent is set.
  IF NEW.booking_id IS NULL AND NEW.group_slot_id IS NULL THEN
    RAISE EXCEPTION 'host occupancy requires a parent'
      USING ERRCODE='not_null_violation',SCHEMA='public',TABLE='booking_hosts',COLUMN='booking_id';
  END IF;
  IF (NEW.booking_id IS NULL)=(NEW.group_slot_id IS NULL) THEN
    RAISE EXCEPTION 'host occupancy requires exactly one parent'
      USING ERRCODE='check_violation',CONSTRAINT='booking_hosts_parent';
  END IF;
  IF NEW.group_slot_id IS NOT NULL THEN
    SELECT tstzrange(s.start_at,s.end_at,'[)'),s.state='open',s.host_user_id
      INTO NEW.period,NEW.active,parent_host FROM group_slots s
      WHERE s.id=NEW.group_slot_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group slot % does not exist', NEW.group_slot_id
        USING ERRCODE='foreign_key_violation',SCHEMA='public',TABLE='booking_hosts',
          COLUMN='group_slot_id',CONSTRAINT='booking_hosts_group_slot_id_fkey';
    END IF;
    IF NEW.user_id<>parent_host THEN
      RAISE EXCEPTION 'group slot occupancy must use its required host'
        USING ERRCODE='check_violation',CONSTRAINT='booking_hosts_group_host';
    END IF;
  ELSE
    SELECT tstzrange(b.start_at,b.end_at,'[)'),b.status<>'cancelled',b.group_slot_id
      INTO NEW.period,NEW.active,seat_slot FROM bookings b
      WHERE b.id=NEW.booking_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'booking % does not exist', NEW.booking_id
        USING ERRCODE='foreign_key_violation',SCHEMA='public',TABLE='booking_hosts',
          COLUMN='booking_id',CONSTRAINT='booking_hosts_booking_id_fkey';
    END IF;
    IF seat_slot IS NOT NULL THEN
      RAISE EXCEPTION 'group seats cannot own host occupancy'
        USING ERRCODE='check_violation',CONSTRAINT='booking_hosts_no_seat_parent';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMENT ON COLUMN booking_hosts.period IS 'Derived from its booking or group slot parent; caller values are replaced.';
COMMENT ON COLUMN booking_hosts.active IS 'Derived from its booking or group slot lifecycle; caller values are replaced.';

CREATE FUNCTION guard_group_slot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE event_mode text;
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT FROM auth.organization WHERE id=OLD.organization_id) THEN
      RAISE EXCEPTION 'retained group slots cannot be deleted individually'
        USING ERRCODE='check_violation',CONSTRAINT='group_slots_retained';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' OR NEW.state IS DISTINCT FROM OLD.state THEN
    -- Generation/tombstone serialization is independent of a later host change.
    -- Epoch microseconds make the key independent of the connection's TimeZone.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'group_slot_interval:' || NEW.original_event_type_id::text || ':' ||
      (extract(epoch FROM NEW.start_at)*1000000)::numeric(30,0)::text || ':' ||
      (extract(epoch FROM NEW.end_at)*1000000)::numeric(30,0)::text,0));
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.active_seats<>0 OR NEW.state<>'open' OR NEW.revision<>1
      OR NEW.count_revision<>1 OR NEW.logistics_revision<>1 THEN
      RAISE EXCEPTION 'new group slot must start empty and open'
        USING ERRCODE='check_violation',CONSTRAINT='group_slots_initial_state';
    END IF;
    SELECT booking_mode INTO event_mode FROM event_types
      WHERE id=NEW.event_type_id AND organization_id=NEW.organization_id FOR SHARE;
    IF NOT FOUND OR event_mode<>'group' OR NEW.event_type_id<>NEW.original_event_type_id THEN
      RAISE EXCEPTION 'group slot requires its live group event'
        USING ERRCODE='check_violation',CONSTRAINT='group_slots_event';
    END IF;
    IF EXISTS (SELECT FROM group_slots WHERE original_event_type_id=NEW.original_event_type_id
      AND start_at=NEW.start_at AND end_at=NEW.end_at AND state='host_cancelled') THEN
      RAISE EXCEPTION 'host cancelled interval cannot reopen'
        USING ERRCODE='check_violation',CONSTRAINT='group_slots_cancelled_interval';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.organization_id,NEW.original_event_type_id,NEW.host_user_id,
      NEW.host_schedule_id,NEW.host_schedule_uses_default,NEW.host_time_zone,NEW.organizer_user_id,
      NEW.destination_calendar_id,NEW.conference_organizer_user_id,NEW.zoom_connection_id,
      NEW.start_at,NEW.end_at,NEW.capacity,NEW.title,NEW.location,NEW.buffer_before_minutes,
      NEW.buffer_after_minutes,NEW.host_notification_settings,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.original_event_type_id,OLD.host_user_id,
      OLD.host_schedule_id,OLD.host_schedule_uses_default,OLD.host_time_zone,OLD.organizer_user_id,
      OLD.destination_calendar_id,OLD.conference_organizer_user_id,OLD.zoom_connection_id,
      OLD.start_at,OLD.end_at,OLD.capacity,OLD.title,OLD.location,OLD.buffer_before_minutes,
      OLD.buffer_after_minutes,OLD.host_notification_settings,OLD.created_at) THEN
    RAISE EXCEPTION 'group slot identity and configuration are immutable'
      USING ERRCODE='check_violation',CONSTRAINT='group_slots_snapshot_immutable';
  END IF;
  IF NEW.event_type_id IS DISTINCT FROM OLD.event_type_id AND NOT
    (NEW.event_type_id IS NULL AND NOT EXISTS (SELECT FROM event_types WHERE id=OLD.event_type_id)) THEN
    RAISE EXCEPTION 'group slot event association is immutable'
      USING ERRCODE='check_violation',CONSTRAINT='group_slots_event_immutable';
  END IF;
  -- Only nested seat bookkeeping writes counters. No caller-controlled session flag.
  -- A deferred exact COUNT below remains the final arbiter even for nested SQL.
  IF (NEW.active_seats IS DISTINCT FROM OLD.active_seats AND pg_trigger_depth()<>2)
    OR NEW.revision<>OLD.revision OR NEW.count_revision<>OLD.count_revision
    OR NEW.logistics_revision<>OLD.logistics_revision THEN
    RAISE EXCEPTION 'group slot counters and revisions are database owned'
      USING ERRCODE='check_violation',CONSTRAINT='group_slots_counter_owned';
  END IF;
  IF OLD.state<>'open' AND NEW.state<>OLD.state THEN
    RAISE EXCEPTION 'terminal group slot cannot reactivate'
      USING ERRCODE='check_violation',CONSTRAINT='group_slots_terminal';
  END IF;
  IF NEW.active_seats IS DISTINCT FROM OLD.active_seats OR NEW.state IS DISTINCT FROM OLD.state THEN
    NEW.revision := OLD.revision+1;
    NEW.count_revision := OLD.count_revision+1;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    NEW.logistics_revision := OLD.logistics_revision+1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER group_slots_guard BEFORE INSERT OR UPDATE OR DELETE ON group_slots
  FOR EACH ROW EXECUTE FUNCTION guard_group_slot();

CREATE FUNCTION guard_group_seat() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE slot group_slots%ROWTYPE; mode text;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.group_slot_id IS NOT NULL AND OLD.status='confirmed'
      AND EXISTS (SELECT FROM auth.organization WHERE id=OLD.organization_id) THEN
      RAISE EXCEPTION 'confirmed group seats must be cancelled before deletion'
        USING ERRCODE='check_violation',CONSTRAINT='bookings_group_confirmed_delete';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.group_slot_id IS NOT NULL OR OLD.group_slot_id IS NOT NULL) THEN
    IF ROW(NEW.id,NEW.organization_id,NEW.group_slot_id,NEW.group_booker_key,NEW.start_at,NEW.end_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.group_slot_id,OLD.group_booker_key,OLD.start_at,OLD.end_at)
      OR (OLD.status='cancelled' AND NEW.status<>'cancelled') THEN
      RAISE EXCEPTION 'group seat binding, mailbox, time and terminal state are immutable'
        USING ERRCODE='check_violation',CONSTRAINT='bookings_group_binding_immutable';
    END IF;
  END IF;
  IF NEW.group_slot_id IS NULL THEN
    IF TG_OP='INSERT' OR NEW.event_type_id IS DISTINCT FROM OLD.event_type_id
      OR (NEW.status='confirmed' AND (NEW.start_at IS DISTINCT FROM OLD.start_at
        OR NEW.end_at IS DISTINCT FROM OLD.end_at OR NEW.status IS DISTINCT FROM OLD.status)) THEN
      IF NEW.event_type_id IS NOT NULL THEN
        -- Fence mode conversion separately from ordinary metadata updates. KEY
        -- SHARE retains the legacy FK lock compatibility with NO KEY UPDATE.
        PERFORM pg_advisory_xact_lock_shared(hashtextextended(
          'event-booking-mode:' || NEW.event_type_id::text,0));
      END IF;
      SELECT booking_mode INTO mode FROM event_types WHERE id=NEW.event_type_id FOR KEY SHARE;
      IF mode='group' THEN
        RAISE EXCEPTION 'group events require a seat binding'
          USING ERRCODE='check_violation',CONSTRAINT='bookings_group_binding_required';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO slot FROM group_slots WHERE id=NEW.group_slot_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group seat parent does not exist' USING ERRCODE='foreign_key_violation';
  END IF;
  IF NEW.organization_id<>slot.organization_id OR NEW.start_at<>slot.start_at OR NEW.end_at<>slot.end_at
    OR NEW.required_host_user_ids IS DISTINCT FROM ARRAY[slot.host_user_id]
    OR NEW.event_type_id IS DISTINCT FROM slot.event_type_id THEN
    -- During physical event deletion FK actions may detach seats before their slot.
    IF NOT (NEW.organization_id=slot.organization_id AND NEW.start_at=slot.start_at
      AND NEW.end_at=slot.end_at AND NEW.required_host_user_ids=ARRAY[slot.host_user_id]
      AND NEW.event_type_id IS NULL AND TG_OP='UPDATE'
      AND NOT EXISTS (SELECT FROM event_types WHERE id=slot.original_event_type_id)) THEN
      RAISE EXCEPTION 'group seat must match its exact slot'
        USING ERRCODE='check_violation',CONSTRAINT='bookings_group_slot_match';
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'confirmed' THEN
      RAISE EXCEPTION 'a new group seat must be confirmed'
        USING ERRCODE='check_violation',CONSTRAINT='bookings_group_initial_status';
    END IF;
    -- Keep the surviving host alive through admission; cancellation remains possible
    -- after host deletion. Membership/readiness/availability are also service checks.
    PERFORM 1 FROM auth."user" WHERE id=slot.host_user_id FOR SHARE;
    IF NOT FOUND OR slot.event_type_id IS NULL OR NOT EXISTS (
      SELECT FROM event_types e WHERE e.id=slot.event_type_id AND e.booking_mode='group'
        AND e.is_active AND e.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'group slot no longer admits seats'
        USING ERRCODE='check_violation',CONSTRAINT='bookings_group_admission';
    END IF;
    UPDATE group_slots SET active_seats=active_seats+1
      WHERE id=slot.id AND state='open' AND active_seats<capacity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group slot has no capacity'
        USING ERRCODE='check_violation',CONSTRAINT='group_slots_capacity_guard';
    END IF;
  ELSIF OLD.status='confirmed' AND NEW.status='cancelled' THEN
    UPDATE group_slots SET active_seats=active_seats-1,
      state=CASE WHEN active_seats=1 AND state='open' THEN 'retired' ELSE state END
      WHERE id=slot.id AND active_seats>0;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group slot counter cannot decrement'
        USING ERRCODE='check_violation',CONSTRAINT='group_slots_capacity_guard';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_group_guard BEFORE INSERT OR UPDATE OR DELETE ON bookings
  FOR EACH ROW EXECUTE FUNCTION guard_group_seat();

CREATE FUNCTION sync_group_slot_hosts() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE booking_hosts SET period=period WHERE group_slot_id=NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER group_slots_sync_hosts AFTER UPDATE OF state ON group_slots
  FOR EACH ROW EXECUTE FUNCTION sync_group_slot_hosts();

CREATE FUNCTION assert_group_slot(target uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE slot group_slots%ROWTYPE; actual bigint;
BEGIN
  SELECT * INTO slot FROM group_slots WHERE id=target FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*) INTO actual FROM bookings WHERE group_slot_id=target AND status='confirmed';
  IF actual<>slot.active_seats OR (slot.state='open')<>(actual>0) THEN
    RAISE EXCEPTION 'group slot count or lifecycle differs from its seats'
      USING ERRCODE='check_violation',CONSTRAINT='group_slots_seat_count';
  END IF;
  -- Recheck after waits as well as at insertion: a concurrent cancellation can
  -- retire the old open tuple while a replacement was waiting on its unique key.
  IF EXISTS (SELECT FROM group_slots s WHERE s.id<>slot.id
    AND s.original_event_type_id=slot.original_event_type_id AND s.start_at=slot.start_at
    AND s.end_at=slot.end_at AND
      ((slot.state='open' AND s.state='host_cancelled') OR
       (slot.state='host_cancelled' AND s.state='open'))) THEN
    RAISE EXCEPTION 'host cancelled interval cannot reopen'
      USING ERRCODE='check_violation',CONSTRAINT='group_slots_cancelled_interval';
  END IF;
  IF slot.state='open' AND EXISTS (SELECT FROM auth."user" WHERE id=slot.host_user_id)
    AND NOT EXISTS (SELECT FROM booking_hosts WHERE group_slot_id=target
      AND user_id=slot.host_user_id AND active AND period=tstzrange(slot.start_at,slot.end_at,'[)')) THEN
    RAISE EXCEPTION 'occupied group slot requires its surviving host occupancy'
      USING ERRCODE='check_violation',CONSTRAINT='group_slots_required_host';
  END IF;
  IF EXISTS (SELECT FROM bookings b WHERE b.group_slot_id=target AND (
    b.organization_id<>slot.organization_id OR b.event_type_id IS DISTINCT FROM slot.event_type_id
    OR b.start_at<>slot.start_at OR b.end_at<>slot.end_at
    OR b.required_host_user_ids IS DISTINCT FROM ARRAY[slot.host_user_id]
    OR (SELECT count(*) FROM booking_attendees a WHERE a.booking_id=b.id)<>1
    OR NOT EXISTS (SELECT FROM booking_attendees a WHERE a.booking_id=b.id AND a.is_booker
      AND normalize_group_booker_key(a.email)=b.group_booker_key)
  )) THEN
    RAISE EXCEPTION 'group seat requires matching slot and one matching booker'
      USING ERRCODE='check_violation',CONSTRAINT='bookings_group_booker';
  END IF;
END $$;

CREATE FUNCTION check_group_slot_invariant() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE target uuid; previous uuid;
BEGIN
  IF TG_TABLE_NAME='group_slots' THEN
    target := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  ELSIF TG_TABLE_NAME='booking_attendees' THEN
    SELECT group_slot_id INTO target FROM bookings WHERE id=
      CASE WHEN TG_OP='DELETE' THEN OLD.booking_id ELSE NEW.booking_id END;
    IF TG_OP='UPDATE' THEN
      SELECT group_slot_id INTO previous FROM bookings WHERE id=OLD.booking_id;
    END IF;
  ELSE
    target := CASE WHEN TG_OP='DELETE' THEN OLD.group_slot_id ELSE NEW.group_slot_id END;
    IF TG_OP='UPDATE' THEN previous := OLD.group_slot_id; END IF;
  END IF;
  IF target IS NOT NULL THEN PERFORM assert_group_slot(target); END IF;
  IF previous IS NOT NULL AND previous IS DISTINCT FROM target THEN PERFORM assert_group_slot(previous); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER group_slots_invariant AFTER INSERT OR UPDATE OR DELETE ON group_slots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_group_slot_invariant();
CREATE CONSTRAINT TRIGGER bookings_group_invariant AFTER INSERT OR UPDATE OR DELETE ON bookings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_group_slot_invariant();
CREATE CONSTRAINT TRIGGER booking_hosts_group_invariant AFTER INSERT OR UPDATE OR DELETE ON booking_hosts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_group_slot_invariant();
CREATE CONSTRAINT TRIGGER booking_attendees_group_invariant AFTER INSERT OR UPDATE OR DELETE ON booking_attendees
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_group_slot_invariant();

CREATE FUNCTION guard_event_booking_mode() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.booking_mode IS DISTINCT FROM OLD.booking_mode THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'event-booking-mode:' || NEW.id::text,0));
  END IF;
  IF NEW.booking_mode IS DISTINCT FROM OLD.booking_mode AND (
    EXISTS (SELECT FROM bookings WHERE event_type_id=OLD.id AND status='confirmed' AND end_at>clock_timestamp())
    OR EXISTS (SELECT FROM group_slots WHERE original_event_type_id=OLD.id AND state='open'
      AND active_seats>0 AND end_at>clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'event mode cannot change while booked work remains'
      USING ERRCODE='check_violation',CONSTRAINT='event_types_group_mode_work';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_types_booking_mode_guard BEFORE UPDATE OF booking_mode ON event_types
  FOR EACH ROW EXECUTE FUNCTION guard_event_booking_mode();

-- Durable retries bind a purpose-specific digest of real initiating authority. A
-- random request key alone grants no access; services must reauthorize before reading.
CREATE TABLE group_booking_move_receipts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  authority_kind text NOT NULL CHECK (authority_kind IN ('capability','session','api_key','oauth')),
  authority_hash bytea NOT NULL CHECK (octet_length(authority_hash)=32),
  request_key text NOT NULL CHECK (request_key COLLATE "C" ~ '^[!-~]{1,255}$'),
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint)=32),
  source_booking_id uuid NOT NULL,
  result_booking_id uuid NOT NULL,
  source_group_slot_id uuid NOT NULL,
  result_group_slot_id uuid NOT NULL,
  is_noop boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (is_noop=(source_booking_id=result_booking_id)),
  FOREIGN KEY (source_booking_id,organization_id) REFERENCES bookings(id,organization_id) ON DELETE CASCADE,
  FOREIGN KEY (result_booking_id,organization_id) REFERENCES bookings(id,organization_id) ON DELETE CASCADE,
  FOREIGN KEY (source_group_slot_id,organization_id) REFERENCES group_slots(id,organization_id) ON DELETE CASCADE,
  FOREIGN KEY (result_group_slot_id,organization_id) REFERENCES group_slots(id,organization_id) ON DELETE CASCADE,
  UNIQUE (organization_id,authority_kind,authority_hash,request_key)
);
CREATE INDEX group_booking_move_receipts_source ON group_booking_move_receipts(source_booking_id);
CREATE INDEX group_booking_move_receipts_result ON group_booking_move_receipts(result_booking_id);
CREATE TABLE group_slot_cancel_receipts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  group_slot_id uuid NOT NULL,
  authority_kind text NOT NULL CHECK (authority_kind IN ('session','api_key','oauth')),
  authority_hash bytea NOT NULL CHECK (octet_length(authority_hash)=32),
  request_key text NOT NULL CHECK (request_key COLLATE "C" ~ '^[!-~]{1,255}$'),
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint)=32),
  cancelled_seat_count integer NOT NULL CHECK (cancelled_seat_count BETWEEN 1 AND 100),
  result_revision bigint NOT NULL CHECK (result_revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (group_slot_id,organization_id) REFERENCES group_slots(id,organization_id) ON DELETE CASCADE,
  UNIQUE (organization_id,authority_kind,authority_hash,request_key)
);
CREATE INDEX group_slot_cancel_receipts_slot ON group_slot_cancel_receipts(group_slot_id);
CREATE FUNCTION guard_group_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='group_booking_move_receipts' THEN
    IF NOT EXISTS (SELECT FROM bookings source JOIN bookings result
        ON result.id=NEW.result_booking_id
      JOIN group_slots source_slot ON source_slot.id=NEW.source_group_slot_id
      JOIN group_slots result_slot ON result_slot.id=NEW.result_group_slot_id
      WHERE source.id=NEW.source_booking_id
        AND source.organization_id=NEW.organization_id AND result.organization_id=NEW.organization_id
        AND source.group_slot_id=source_slot.id AND result.group_slot_id=result_slot.id
        AND source_slot.original_event_type_id=result_slot.original_event_type_id
        AND source_slot.host_user_id=result_slot.host_user_id
        AND (NEW.is_noop OR (source.status='cancelled' AND result.rescheduled_from_id=source.id))) THEN
      RAISE EXCEPTION 'group move receipt must describe its own seat operation'
        USING ERRCODE='check_violation',CONSTRAINT='group_move_receipt_binding';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT FROM group_slots WHERE id=NEW.group_slot_id
      AND organization_id=NEW.organization_id AND state='host_cancelled'
      AND active_seats=0 AND revision=NEW.result_revision) THEN
      RAISE EXCEPTION 'group cancellation receipt must describe its terminal slot'
        USING ERRCODE='check_violation',CONSTRAINT='group_cancel_receipt_binding';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER group_move_receipts_binding BEFORE INSERT ON group_booking_move_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_group_receipt();
CREATE TRIGGER group_cancel_receipts_binding BEFORE INSERT ON group_slot_cancel_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_group_receipt();
CREATE FUNCTION immutable_group_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'group operation receipts are immutable'
    USING ERRCODE='check_violation',CONSTRAINT='group_operation_receipt_immutable';
END $$;
CREATE TRIGGER group_move_receipts_immutable BEFORE UPDATE ON group_booking_move_receipts
  FOR EACH ROW EXECUTE FUNCTION immutable_group_receipt();
CREATE TRIGGER group_cancel_receipts_immutable BEFORE UPDATE ON group_slot_cancel_receipts
  FOR EACH ROW EXECUTE FUNCTION immutable_group_receipt();
ALTER TABLE organization_operations ADD COLUMN group_slot_id uuid,
  ADD CONSTRAINT organization_operations_group_slot_fkey FOREIGN KEY (group_slot_id,organization_id)
    REFERENCES group_slots(id,organization_id) ON DELETE CASCADE;
CREATE INDEX organization_operations_group_slot ON organization_operations(group_slot_id)
  WHERE group_slot_id IS NOT NULL;
CREATE FUNCTION guard_group_operation_attribution() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.group_slot_id IS NOT NULL AND (NEW.operation<>'booking_cancelled' OR NOT EXISTS (
    SELECT FROM bookings WHERE id=NEW.booking_id AND organization_id=NEW.organization_id
      AND group_slot_id=NEW.group_slot_id
  )) THEN
    RAISE EXCEPTION 'group operation attribution must match its own seat'
      USING ERRCODE='check_violation',CONSTRAINT='organization_operations_group_binding';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organization_operations_group_binding BEFORE INSERT OR UPDATE ON organization_operations
  FOR EACH ROW EXECUTE FUNCTION guard_group_operation_attribution();

-- Append-only wakeups reuse the existing no-lock/no-shared-writer signal design.
-- Capacity-aware admission/discovery and integration outboxes belong to later tasks.
CREATE FUNCTION signal_waitlist_group_slot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM dirty_waitlist_host(CASE WHEN TG_OP='DELETE' THEN OLD.host_user_id ELSE NEW.host_user_id END);
  RETURN NULL;
END $$;
CREATE TRIGGER group_slots_waitlist_signal AFTER INSERT OR UPDATE OF active_seats,state OR DELETE ON group_slots
  FOR EACH ROW EXECUTE FUNCTION signal_waitlist_group_slot();
