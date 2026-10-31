-- Waitlists are opt-in. No historical contacts, receipts, jobs or accounting rows
-- are read or rewritten. All processes must use the matching service protocol.
ALTER TABLE event_types ADD COLUMN waitlist_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  event_type_id uuid NOT NULL,
  recipient_hash bytea NOT NULL CHECK (octet_length(recipient_hash)=32),
  email text,
  name text,
  window_start timestamptz,
  window_end timestamptz,
  time_zone text,
  locale text,
  consent_version text NOT NULL,
  consented_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification','active','notified','booked','expired','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  pending_expires_at timestamptz NOT NULL,
  verification_generation integer NOT NULL DEFAULT 1 CHECK (verification_generation > 0),
  verified_at timestamptz,
  terminal_at timestamptz,
  terminal_reason text CHECK (terminal_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  FOREIGN KEY (event_type_id,organization_id) REFERENCES event_types(id,organization_id)
    ON DELETE CASCADE,
  CHECK (isfinite(created_at) AND isfinite(expires_at) AND isfinite(pending_expires_at)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '720 hours'),
  CHECK (pending_expires_at > created_at AND pending_expires_at <= expires_at
    AND pending_expires_at <= created_at + interval '24 hours'),
  CHECK ((window_start IS NULL) = (window_end IS NULL)),
  CHECK (window_start IS NULL OR (isfinite(window_start) AND isfinite(window_end)
    AND window_start >= created_at AND window_end > window_start
    AND window_end <= created_at + interval '1488 hours'
    AND expires_at = least(created_at + interval '720 hours',window_end))),
  CHECK (status NOT IN ('pending_verification','active','notified') OR
    (email IS NOT NULL AND window_start IS NOT NULL AND time_zone IS NOT NULL AND locale IS NOT NULL)),
  CHECK (status NOT IN ('active','notified','booked') OR verified_at IS NOT NULL),
  CHECK ((status IN ('booked','expired','removed')) = (terminal_at IS NOT NULL))
);
CREATE UNIQUE INDEX waitlist_entries_live_recipient ON waitlist_entries(event_type_id,recipient_hash)
  WHERE status IN ('pending_verification','active','notified');
CREATE INDEX waitlist_entries_expiry ON waitlist_entries(expires_at,id)
  WHERE status IN ('pending_verification','active','notified');
CREATE INDEX waitlist_entries_pending_expiry ON waitlist_entries(pending_expires_at,id)
  WHERE status='pending_verification';
CREATE INDEX waitlist_entries_terminal ON waitlist_entries(terminal_at,id)
  WHERE terminal_at IS NOT NULL;

CREATE TABLE waitlist_capabilities (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  entry_id uuid NOT NULL REFERENCES waitlist_entries(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verification','management')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (isfinite(expires_at) AND expires_at > created_at)
);
CREATE INDEX waitlist_capabilities_entry ON waitlist_capabilities(entry_id);
CREATE INDEX waitlist_capabilities_expiry ON waitlist_capabilities(expires_at);

CREATE TABLE waitlist_verification_outbox (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  entry_id uuid NOT NULL REFERENCES waitlist_entries(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  generation integer NOT NULL CHECK (generation > 0),
  encrypted_payload bytea,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','processing','accepted','suppressed','failed','expired','superseded','removed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_until timestamptz,
  last_job_id uuid,
  accepted_at timestamptz,
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id,generation),
  CHECK ((claim_token IS NULL) = (lease_until IS NULL)),
  CHECK (state NOT IN ('pending','processing') OR encrypted_payload IS NOT NULL),
  CHECK (isfinite(expires_at) AND expires_at > created_at)
);
CREATE INDEX waitlist_verification_outbox_repair ON waitlist_verification_outbox(next_attempt_at,id)
  WHERE state IN ('pending','processing');

-- Independent two-day ledgers: deleting an entry or event cannot replenish caps.
CREATE TABLE waitlist_verification_requests (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_type_id uuid NOT NULL,
  email_hash bytea NOT NULL CHECK (octet_length(email_hash)=32),
  ip_hash bytea NOT NULL CHECK (octet_length(ip_hash)=32),
  generation_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX waitlist_verification_requests_email ON waitlist_verification_requests(email_hash,requested_at);
CREATE INDEX waitlist_verification_requests_ip ON waitlist_verification_requests(ip_hash,requested_at);
CREATE INDEX waitlist_verification_requests_event ON waitlist_verification_requests(event_type_id,requested_at);
CREATE INDEX waitlist_verification_requests_cleanup ON waitlist_verification_requests(requested_at);

CREATE TABLE waitlist_key_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  secret_fingerprint bytea NOT NULL CHECK (octet_length(secret_fingerprint)=32),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE waitlist_scan_work (
  event_type_id uuid PRIMARY KEY REFERENCES event_types(id) ON DELETE CASCADE,
  dirty_generation integer NOT NULL DEFAULT 1,
  scanned_generation integer NOT NULL DEFAULT 0,
  next_due_at timestamptz NOT NULL DEFAULT now(),
  cursor_entry_id uuid,
  cursor_start_at timestamptz,
  last_scanned_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX waitlist_scan_work_due ON waitlist_scan_work(next_due_at,event_type_id);

CREATE TABLE waitlist_slots (
  event_type_id uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  is_open boolean NOT NULL,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_type_id,start_at,end_at),
  CHECK (isfinite(start_at) AND isfinite(end_at) AND end_at > start_at)
);
CREATE INDEX waitlist_slots_cleanup ON waitlist_slots(end_at);

CREATE TABLE waitlist_cohorts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_type_id uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  discovered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX waitlist_cohorts_event ON waitlist_cohorts(event_type_id,discovered_at);

CREATE TABLE waitlist_candidates (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  cohort_id uuid NOT NULL REFERENCES waitlist_cohorts(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES waitlist_entries(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  event_type_id uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  slots jsonb NOT NULL CHECK (jsonb_typeof(slots)='array' AND jsonb_array_length(slots) BETWEEN 1 AND 3),
  due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','processing','accepted','suppressed','rejected','expired','obsolete','failed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_until timestamptz,
  last_job_id uuid,
  accepted_at timestamptz,
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_id,entry_id),
  CHECK (isfinite(due_at) AND isfinite(expires_at) AND expires_at > due_at
    AND expires_at <= due_at + interval '24 hours'),
  CHECK ((claim_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX waitlist_candidates_entry ON waitlist_candidates(entry_id);
CREATE INDEX waitlist_candidates_repair ON waitlist_candidates(next_attempt_at,id)
  WHERE state IN ('pending','processing');

-- No foreign keys: pseudonymous exact-slot suppression survives remove/rejoin,
-- event deletion, delivery cleanup and queue repair. All arithmetic is elapsed UTC.
CREATE TABLE waitlist_slot_tombstones (
  event_type_id uuid NOT NULL,
  recipient_hash bytea NOT NULL CHECK (octet_length(recipient_hash)=32),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN
    ('pending','accepted','suppressed','rejected','expired','obsolete','failed')),
  consumed_at timestamptz NOT NULL DEFAULT now(),
  purge_at timestamptz NOT NULL,
  PRIMARY KEY (event_type_id,recipient_hash,start_at,end_at),
  CHECK (isfinite(start_at) AND isfinite(end_at) AND end_at > start_at),
  CHECK (purge_at = end_at + interval '48 hours')
);
CREATE INDEX waitlist_slot_tombstones_cleanup ON waitlist_slot_tombstones(purge_at);

-- Repair may replace lost job IDs, but may not rewrite an opportunity, revive a
-- final outcome or replenish attempts consumed before a process crash.
CREATE FUNCTION protect_waitlist_candidate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.cohort_id IS DISTINCT FROM OLD.cohort_id OR NEW.entry_id IS DISTINCT FROM OLD.entry_id
    OR NEW.event_type_id IS DISTINCT FROM OLD.event_type_id OR NEW.slots IS DISTINCT FROM OLD.slots
    OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'waitlist candidate identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'waitlist candidate attempts cannot decrease' USING ERRCODE='23514';
  END IF;
  IF OLD.state NOT IN ('pending','processing') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'waitlist candidate outcome is final' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER waitlist_candidates_protect BEFORE UPDATE ON waitlist_candidates
  FOR EACH ROW EXECUTE FUNCTION protect_waitlist_candidate();

CREATE FUNCTION protect_waitlist_verification_work() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.entry_id IS DISTINCT FROM OLD.entry_id OR NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'waitlist verification identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'waitlist verification attempts cannot decrease' USING ERRCODE='23514';
  END IF;
  IF OLD.state NOT IN ('pending','processing') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'waitlist verification outcome is final' USING ERRCODE='23514';
  END IF;
  IF NEW.state NOT IN ('pending','processing') THEN NEW.encrypted_payload := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER waitlist_verification_outbox_protect BEFORE UPDATE ON waitlist_verification_outbox
  FOR EACH ROW EXECUTE FUNCTION protect_waitlist_verification_work();

CREATE FUNCTION protect_waitlist_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.pending_expires_at IS DISTINCT FROM OLD.pending_expires_at
    OR NEW.event_type_id IS DISTINCT FROM OLD.event_type_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.recipient_hash IS DISTINCT FROM OLD.recipient_hash THEN
    RAISE EXCEPTION 'waitlist identity and deadlines are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status IN ('booked','expired','removed') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'waitlist terminal state is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status IN ('booked','expired','removed') AND NEW.terminal_at IS NULL THEN
    NEW.terminal_at := now();
  END IF;
  IF NEW.status='removed' THEN
    NEW.email := NULL; NEW.name := NULL; NEW.window_start := NULL; NEW.window_end := NULL;
    NEW.time_zone := NULL; NEW.locale := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER waitlist_entries_protect BEFORE UPDATE ON waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION protect_waitlist_entry();

CREATE FUNCTION retire_waitlist_entry_work() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IN ('booked','expired','removed') THEN
    UPDATE waitlist_capabilities SET revoked_at=coalesce(revoked_at,now())
      WHERE entry_id=NEW.id AND revoked_at IS NULL;
    UPDATE waitlist_verification_outbox SET state='removed',
      claim_token=NULL,lease_until=NULL,updated_at=now()
      WHERE entry_id=NEW.id AND state IN ('pending','processing');
    UPDATE waitlist_verification_outbox SET encrypted_payload=NULL
      WHERE entry_id=NEW.id AND encrypted_payload IS NOT NULL;
    UPDATE waitlist_candidates SET state='obsolete',claim_token=NULL,lease_until=NULL,updated_at=now()
      WHERE entry_id=NEW.id AND state IN ('pending','processing');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER waitlist_entries_retire_work AFTER UPDATE OF status ON waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION retire_waitlist_entry_work();

CREATE FUNCTION dirty_waitlist_event(target uuid) RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO waitlist_scan_work(event_type_id)
    SELECT id FROM event_types WHERE id=target AND waitlist_enabled
  ON CONFLICT (event_type_id) DO UPDATE SET
    dirty_generation=waitlist_scan_work.dirty_generation+1,
    next_due_at=least(waitlist_scan_work.next_due_at,now()),updated_at=now();
$$;
CREATE FUNCTION dirty_waitlist_host(target uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE event_id uuid;
BEGIN
  FOR event_id IN SELECT e.id FROM event_types e JOIN event_type_hosts h ON h.event_type_id=e.id
    WHERE h.user_id=target AND e.waitlist_enabled ORDER BY e.id LOOP
    PERFORM dirty_waitlist_event(event_id);
  END LOOP;
END $$;

CREATE FUNCTION signal_waitlist_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE host_id uuid;
BEGIN
  IF (OLD.waitlist_enabled AND NOT NEW.waitlist_enabled) OR NOT NEW.is_active
    OR NEW.deleted_at IS NOT NULL OR NEW.scheduling_type IS DISTINCT FROM OLD.scheduling_type
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    UPDATE waitlist_entries SET status='removed',terminal_reason=
      CASE WHEN NEW.scheduling_type IS DISTINCT FROM OLD.scheduling_type
        OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN 'configuration_changed'
        ELSE 'event_disabled' END
      WHERE event_type_id=NEW.id AND status IN ('pending_verification','active','notified');
  END IF;
  IF NEW.waitlist_enabled AND NEW.scheduling_type<>'individual' THEN
    UPDATE event_types SET waitlist_enabled=false WHERE id=NEW.id;
  END IF;
  -- Buffers and other rules on an existing booking's event can change offered
  -- times for another event, including one belonging to a different team.
  FOR host_id IN SELECT user_id FROM event_type_hosts WHERE event_type_id=NEW.id ORDER BY user_id LOOP
    PERFORM dirty_waitlist_host(host_id);
  END LOOP;
  IF NOT EXISTS (SELECT FROM event_type_hosts WHERE event_type_id=NEW.id) THEN
    PERFORM dirty_waitlist_event(NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER event_types_waitlist_signal AFTER UPDATE ON event_types
  FOR EACH ROW EXECUTE FUNCTION signal_waitlist_event();

CREATE FUNCTION signal_waitlist_host() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE target uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM dirty_waitlist_host(OLD.user_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM dirty_waitlist_host(NEW.user_id); END IF;
  IF TG_TABLE_NAME='event_type_hosts' THEN
    target := CASE WHEN TG_OP='DELETE' THEN OLD.event_type_id ELSE NEW.event_type_id END;
    IF TG_OP IN ('INSERT','DELETE') OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      UPDATE waitlist_entries SET status='removed',terminal_reason='configuration_changed'
        WHERE event_type_id=target AND status IN ('pending_verification','active','notified');
    END IF;
    PERFORM dirty_waitlist_event(target);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER event_type_hosts_waitlist_signal AFTER INSERT OR UPDATE OR DELETE ON event_type_hosts
  FOR EACH ROW EXECUTE FUNCTION signal_waitlist_host();

-- Host replacement deletes then inserts within one transaction. Validate only the
-- committed host shape so a supported replacement does not switch waitlists off
-- because of its temporary zero-host state. Existing entries are still retired
-- immediately by the mutation signal above.
CREATE FUNCTION enforce_waitlist_host_shape() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE target uuid;
BEGIN
  target := CASE WHEN TG_OP='DELETE' THEN OLD.event_type_id ELSE NEW.event_type_id END;
  UPDATE event_types e SET waitlist_enabled=false
    WHERE e.id=target AND e.waitlist_enabled AND
      (e.scheduling_type<>'individual'
       OR (SELECT count(*) FROM event_type_hosts h WHERE h.event_type_id=e.id)<>1
       OR (e.owner_user_id IS NOT NULL AND NOT EXISTS
         (SELECT FROM event_type_hosts h WHERE h.event_type_id=e.id AND h.user_id=e.owner_user_id)));
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER event_type_hosts_waitlist_shape
  AFTER INSERT OR UPDATE OR DELETE ON event_type_hosts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_waitlist_host_shape();
CREATE TRIGGER booking_hosts_waitlist_signal AFTER INSERT OR UPDATE OR DELETE ON booking_hosts
  FOR EACH ROW EXECUTE FUNCTION signal_waitlist_host();
CREATE TRIGGER schedules_waitlist_signal AFTER INSERT OR UPDATE OR DELETE ON schedules
  FOR EACH ROW EXECUTE FUNCTION signal_waitlist_host();
CREATE TRIGGER profiles_waitlist_signal AFTER INSERT OR UPDATE OR DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION signal_waitlist_host();

CREATE FUNCTION signal_waitlist_override() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE host_id uuid;
BEGIN
  FOR host_id IN SELECT user_id FROM schedules WHERE id IN
    (CASE WHEN TG_OP<>'INSERT' THEN OLD.schedule_id END,
     CASE WHEN TG_OP<>'DELETE' THEN NEW.schedule_id END) LOOP
    PERFORM dirty_waitlist_host(host_id);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER schedule_overrides_waitlist_signal AFTER INSERT OR UPDATE OR DELETE ON schedule_overrides
  FOR EACH ROW EXECUTE FUNCTION signal_waitlist_override();

CREATE FUNCTION signal_waitlist_calendar() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE host_id uuid;
BEGIN
  IF TG_TABLE_NAME='calendar_connections' THEN
    IF TG_OP<>'INSERT' THEN PERFORM dirty_waitlist_host(OLD.user_id); END IF;
    IF TG_OP<>'DELETE' THEN PERFORM dirty_waitlist_host(NEW.user_id); END IF;
  ELSIF TG_TABLE_NAME='calendars' THEN
    FOR host_id IN SELECT user_id FROM calendar_connections WHERE id IN
      (CASE WHEN TG_OP<>'INSERT' THEN OLD.connection_id END,
       CASE WHEN TG_OP<>'DELETE' THEN NEW.connection_id END) LOOP
      PERFORM dirty_waitlist_host(host_id);
    END LOOP;
  ELSE
    FOR host_id IN SELECT cc.user_id FROM calendar_connections cc
      JOIN calendars c ON c.connection_id=cc.id WHERE c.id IN
      (CASE WHEN TG_OP<>'INSERT' THEN OLD.calendar_id END,
       CASE WHEN TG_OP<>'DELETE' THEN NEW.calendar_id END) LOOP
      PERFORM dirty_waitlist_host(host_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER calendar_connections_waitlist_signal AFTER INSERT OR UPDATE OR DELETE ON calendar_connections
  FOR EACH ROW EXECUTE FUNCTION signal_waitlist_calendar();
CREATE TRIGGER calendars_waitlist_signal AFTER INSERT OR UPDATE OR DELETE ON calendars
  FOR EACH ROW EXECUTE FUNCTION signal_waitlist_calendar();
CREATE TRIGGER calendar_busy_waitlist_signal AFTER INSERT OR UPDATE OR DELETE ON calendar_busy
  FOR EACH ROW EXECUTE FUNCTION signal_waitlist_calendar();
