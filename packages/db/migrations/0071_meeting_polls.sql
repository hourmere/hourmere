-- Storage foundation only; admission and delivery workers land separately.
CREATE UNIQUE INDEX bookings_organization_identity ON bookings(organization_id,id);
CREATE TABLE meeting_polls (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  event_type_id uuid NOT NULL,
  created_by_user_id uuid REFERENCES auth."user"(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'web' CHECK (source IN ('web','api','mcp')),
  api_key_id uuid,
  title text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  display_time_zone text NOT NULL,
  settings_snapshot jsonb NOT NULL CHECK (jsonb_typeof(settings_snapshot)='object'),
  settings_fingerprint bytea NOT NULL CHECK (octet_length(settings_fingerprint)=32),
  admission_mode text NOT NULL CHECK (admission_mode IN ('public_link','invited')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','aggregate')),
  deadline_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','scheduled','canceled')),
  closed_at timestamptz,
  canceled_at timestamptz,
  scheduled_at timestamptz,
  chosen_slot_id uuid,
  booking_id uuid UNIQUE,
  public_token_digest bytea UNIQUE CHECK (octet_length(public_token_digest)=32),
  host_revision integer NOT NULL DEFAULT 1 CHECK (host_revision>0),
  results_revision integer NOT NULL DEFAULT 1 CHECK (results_revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  CONSTRAINT meeting_polls_source_api_key_check CHECK (api_key_id IS NULL OR source IN ('api','mcp')),
  CONSTRAINT meeting_polls_event_fk FOREIGN KEY(event_type_id,organization_id)
    REFERENCES event_types(id,organization_id) ON DELETE CASCADE,
  CONSTRAINT meeting_polls_booking_fk FOREIGN KEY(organization_id,booking_id)
    REFERENCES bookings(organization_id,id),
  CONSTRAINT meeting_polls_deadline_cap CHECK (isfinite(deadline_at) AND
    deadline_at BETWEEN created_at+interval '1 hour' AND created_at+interval '720 hours'),
  CONSTRAINT meeting_polls_scheduled_pair CHECK (
    (status='scheduled')=(chosen_slot_id IS NOT NULL) AND
    (status='scheduled')=(booking_id IS NOT NULL) AND
    (status='scheduled')=(scheduled_at IS NOT NULL)),
  CONSTRAINT meeting_polls_lifecycle_pair CHECK (
    (status='canceled')=(canceled_at IS NOT NULL) AND
    (status<>'open' OR closed_at IS NULL) AND (status<>'closed' OR closed_at IS NOT NULL)),
  CHECK (admission_mode<>'invited' OR public_token_digest IS NULL)
);
CREATE INDEX meeting_polls_page ON meeting_polls(organization_id,created_at,id);
CREATE INDEX meeting_polls_creator_idx ON meeting_polls(created_by_user_id);
CREATE INDEX meeting_polls_deadline ON meeting_polls(deadline_at,id) WHERE status='open';
CREATE TABLE meeting_poll_slots (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  poll_id uuid NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 19),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,poll_id,id),
  UNIQUE (poll_id,start_at,end_at),
  UNIQUE (poll_id,position),
  CONSTRAINT meeting_poll_slots_poll_fk FOREIGN KEY(organization_id,poll_id)
    REFERENCES meeting_polls(organization_id,id) ON DELETE CASCADE,
  CHECK (isfinite(start_at) AND isfinite(end_at) AND end_at>start_at)
);
ALTER TABLE meeting_polls ADD CONSTRAINT meeting_polls_chosen_slot_fk
  FOREIGN KEY(organization_id,id,chosen_slot_id)
  REFERENCES meeting_poll_slots(organization_id,poll_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX meeting_poll_slots_start ON meeting_poll_slots(poll_id,start_at);
CREATE TABLE meeting_poll_voters (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  poll_id uuid NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  email_key bytea NOT NULL CHECK (octet_length(email_key)=32),
  verified_at timestamptz,
  pending_expires_at timestamptz,
  invited_at timestamptz,
  withdrawn_at timestamptz,
  ballot_submitted_at timestamptz,
  admission_ip_digest bytea CHECK (octet_length(admission_ip_digest)=32),
  time_zone text NOT NULL,
  locale text NOT NULL,
  responses jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(responses)='object'),
  join_consent_at timestamptz,
  ballot_revision integer NOT NULL DEFAULT 0 CHECK (ballot_revision>=0),
  selected_booking_role text CHECK (selected_booking_role IN ('booker','guest')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,poll_id,id),
  UNIQUE (poll_id,email_key),
  CONSTRAINT meeting_poll_voters_poll_fk FOREIGN KEY(organization_id,poll_id)
    REFERENCES meeting_polls(organization_id,id) ON DELETE CASCADE,
  CONSTRAINT meeting_poll_voters_pending_pair CHECK (
    (verified_at IS NULL AND invited_at IS NULL AND withdrawn_at IS NULL)=(pending_expires_at IS NOT NULL)
    AND (pending_expires_at IS NULL)=(admission_ip_digest IS NULL)),
  CONSTRAINT meeting_poll_voters_pending_cap CHECK (pending_expires_at IS NULL OR
    (isfinite(pending_expires_at) AND pending_expires_at>created_at AND pending_expires_at<=created_at+interval '1 hour')),
  CONSTRAINT meeting_poll_voters_ballot_pair CHECK (ballot_submitted_at IS NULL OR
    (verified_at IS NOT NULL AND withdrawn_at IS NULL AND join_consent_at IS NOT NULL)),
  CONSTRAINT meeting_poll_voters_withdrawn_pair CHECK (withdrawn_at IS NULL OR
    (ballot_submitted_at IS NULL AND responses='{}'::jsonb AND join_consent_at IS NULL AND admission_ip_digest IS NULL)),
  CHECK (selected_booking_role IS NULL OR (verified_at IS NOT NULL AND withdrawn_at IS NULL AND join_consent_at IS NOT NULL))
);
CREATE INDEX meeting_poll_voters_roster ON meeting_poll_voters(poll_id,verified_at);
CREATE INDEX meeting_poll_voters_expiry ON meeting_poll_voters(poll_id,pending_expires_at);
CREATE TABLE meeting_poll_votes (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  poll_id uuid NOT NULL,
  voter_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  value text NOT NULL CHECK (value IN ('yes','if_need_be','no')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(poll_id,voter_id,slot_id),
  CONSTRAINT meeting_poll_votes_voter_fk FOREIGN KEY(organization_id,poll_id,voter_id)
    REFERENCES meeting_poll_voters(organization_id,poll_id,id) ON DELETE CASCADE,
  CONSTRAINT meeting_poll_votes_slot_fk FOREIGN KEY(organization_id,poll_id,slot_id)
    REFERENCES meeting_poll_slots(organization_id,poll_id,id) ON DELETE CASCADE
);
CREATE INDEX meeting_poll_votes_tally ON meeting_poll_votes(poll_id,slot_id,value);
CREATE TABLE meeting_poll_capabilities (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  poll_id uuid NOT NULL,
  voter_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('verification','voting','reminder_opt_out')),
  capability_ciphertext bytea,
  token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest)=32),
  generation integer NOT NULL DEFAULT 1 CHECK (generation>0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_poll_capabilities_voter_fk FOREIGN KEY(organization_id,poll_id,voter_id)
    REFERENCES meeting_poll_voters(organization_id,poll_id,id) ON DELETE CASCADE,
  CHECK (isfinite(expires_at) AND expires_at>created_at),
  CHECK (revoked_at IS NULL OR capability_ciphertext IS NULL)
);
CREATE INDEX meeting_poll_capabilities_voter ON meeting_poll_capabilities(poll_id,voter_id);
CREATE INDEX meeting_poll_capabilities_expiry ON meeting_poll_capabilities(expires_at,id) WHERE capability_ciphertext IS NOT NULL;
CREATE TABLE meeting_poll_mailbox_counters (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  poll_id uuid NOT NULL,
  email_key bytea NOT NULL CHECK (octet_length(email_key)=32),
  resend_count integer NOT NULL DEFAULT 0,
  last_resend_at timestamptz,
  recovery_count integer NOT NULL DEFAULT 0,
  last_recovery_at timestamptz,
  reminder_consumed_at timestamptz,
  reminder_opted_out_at timestamptz,
  removed_at timestamptz,
  purge_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(poll_id,email_key),
  CONSTRAINT meeting_poll_mailbox_counters_poll_fk FOREIGN KEY(organization_id,poll_id)
    REFERENCES meeting_polls(organization_id,id) ON DELETE CASCADE,
  CONSTRAINT meeting_poll_mailbox_counters_resend_cap CHECK (resend_count BETWEEN 0 AND 3),
  CONSTRAINT meeting_poll_mailbox_counters_recovery_cap CHECK (recovery_count BETWEEN 0 AND 3),
  CHECK ((resend_count=0)=(last_resend_at IS NULL)),
  CHECK ((recovery_count=0)=(last_recovery_at IS NULL))
);
CREATE TABLE meeting_poll_operations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  poll_id uuid,
  operation text NOT NULL CHECK (operation IN ('create','invite','resend','rotate_link','finalize')),
  actor_scope_digest bytea NOT NULL CHECK (octet_length(actor_scope_digest)=32),
  idempotency_key_digest bytea NOT NULL CHECK (octet_length(idempotency_key_digest)=32),
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint)=32),
  booking_id uuid,
  purge_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,operation,actor_scope_digest,idempotency_key_digest),
  CONSTRAINT meeting_poll_operations_poll_fk FOREIGN KEY(organization_id,poll_id)
    REFERENCES meeting_polls(organization_id,id) ON DELETE SET NULL (poll_id),
  CONSTRAINT meeting_poll_operations_booking_fk FOREIGN KEY(organization_id,booking_id)
    REFERENCES bookings(organization_id,id) ON DELETE SET NULL (booking_id),
  CHECK (poll_id IS NOT NULL OR (booking_id IS NULL AND purge_at IS NOT NULL))
);
CREATE INDEX meeting_poll_operations_poll ON meeting_poll_operations(poll_id);
CREATE INDEX meeting_poll_operations_cleanup ON meeting_poll_operations(purge_at,id) WHERE purge_at IS NOT NULL;
CREATE TABLE meeting_poll_deliveries (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  poll_id uuid NOT NULL,
  voter_id uuid,
  host_user_id uuid REFERENCES auth."user"(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('verification','invitation','recovery','reminder','selected','canceled','booking_update','deadline_closed')),
  generation integer NOT NULL DEFAULT 1 CHECK (generation>0),
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence>=0),
  due_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent','suppressed','skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  lease_id uuid,
  lease_until timestamptz,
  capability_ciphertext bytea,
  error_class text CHECK (error_class ~ '^[a-z][a-z0-9_]{0,63}$'),
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_poll_deliveries_poll_fk FOREIGN KEY(organization_id,poll_id)
    REFERENCES meeting_polls(organization_id,id) ON DELETE CASCADE,
  CONSTRAINT meeting_poll_deliveries_voter_fk FOREIGN KEY(organization_id,poll_id,voter_id)
    REFERENCES meeting_poll_voters(organization_id,poll_id,id) ON DELETE CASCADE,
  CONSTRAINT meeting_poll_deliveries_recipient_pair CHECK (num_nonnulls(voter_id,host_user_id)=1),
  CONSTRAINT meeting_poll_deliveries_lease_pair CHECK ((lease_id IS NULL)=(lease_until IS NULL)
    AND (state='processing')=(lease_id IS NOT NULL)),
  CONSTRAINT meeting_poll_deliveries_terminal_pair CHECK ((state IN ('sent','suppressed','skipped'))=(terminal_at IS NOT NULL)
    AND (terminal_at IS NULL OR capability_ciphertext IS NULL)),
  CHECK ((kind='deadline_closed')=(host_user_id IS NOT NULL)),
  CHECK (host_user_id IS NULL OR (sequence=0 AND capability_ciphertext IS NULL))
);
CREATE UNIQUE INDEX meeting_poll_deliveries_voter_identity ON meeting_poll_deliveries(poll_id,voter_id,kind,generation,sequence) WHERE voter_id IS NOT NULL;
CREATE UNIQUE INDEX meeting_poll_deliveries_host_identity ON meeting_poll_deliveries(poll_id,host_user_id,kind,generation) WHERE host_user_id IS NOT NULL;
CREATE INDEX meeting_poll_deliveries_due ON meeting_poll_deliveries(due_at,id) WHERE state='pending';
CREATE INDEX meeting_poll_deliveries_claims ON meeting_poll_deliveries(lease_until,id) WHERE state='processing';
CREATE INDEX meeting_poll_deliveries_host_idx ON meeting_poll_deliveries(host_user_id);

-- Child writers serialize their cross-row bounds on the common parent row.
CREATE FUNCTION guard_meeting_poll_slot() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE parent meeting_polls;
BEGIN
  SELECT * INTO parent FROM meeting_polls WHERE id=NEW.poll_id AND organization_id=NEW.organization_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF; -- Scoped FK supplies the diagnostic.
  IF TG_OP='UPDATE' AND (NEW.poll_id,NEW.organization_id,NEW.start_at,NEW.end_at,NEW.position)
    IS DISTINCT FROM (OLD.poll_id,OLD.organization_id,OLD.start_at,OLD.end_at,OLD.position) THEN
    RAISE EXCEPTION 'poll candidates are immutable' USING ERRCODE='23514',CONSTRAINT='meeting_poll_slots_immutable';
  END IF;
  IF NEW.end_at-NEW.start_at<>make_interval(mins=>parent.duration_minutes) OR NEW.start_at<=parent.deadline_at THEN
    RAISE EXCEPTION 'poll candidate interval does not match' USING ERRCODE='23514',CONSTRAINT='meeting_poll_slots_interval';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meeting_poll_slots_guard BEFORE INSERT OR UPDATE ON meeting_poll_slots
  FOR EACH ROW EXECUTE FUNCTION guard_meeting_poll_slot();

CREATE FUNCTION check_meeting_poll_slot_count() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE target uuid; total integer;
BEGIN
  IF TG_TABLE_NAME='meeting_polls' THEN
    target:=NEW.id;
  ELSIF TG_OP='DELETE' THEN
    target:=OLD.poll_id;
  ELSE
    target:=NEW.poll_id;
  END IF;
  PERFORM 1 FROM meeting_polls WHERE id=target FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO total FROM meeting_poll_slots WHERE poll_id=target;
  IF total NOT BETWEEN 2 AND 20 THEN
    RAISE EXCEPTION 'poll requires 2 to 20 candidates' USING ERRCODE='23514',CONSTRAINT='meeting_poll_slots_count_cap';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER meeting_polls_slot_count AFTER INSERT ON meeting_polls
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_meeting_poll_slot_count();
CREATE CONSTRAINT TRIGGER meeting_poll_slots_count AFTER INSERT OR UPDATE OR DELETE ON meeting_poll_slots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_meeting_poll_slot_count();

CREATE FUNCTION guard_meeting_poll_voter() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE parent meeting_polls; checked_at timestamptz; total integer;
BEGIN
  SELECT * INTO parent FROM meeting_polls WHERE id=NEW.poll_id AND organization_id=NEW.organization_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  checked_at:=clock_timestamp();
  IF NEW.pending_expires_at>parent.deadline_at THEN
    RAISE EXCEPTION 'pending reservation exceeds deadline' USING ERRCODE='23514',CONSTRAINT='meeting_poll_voters_pending_deadline';
  END IF;
  IF NEW.withdrawn_at IS NULL AND (NEW.verified_at IS NOT NULL OR NEW.invited_at IS NOT NULL OR NEW.pending_expires_at>checked_at) THEN
    SELECT count(*) INTO total FROM meeting_poll_voters WHERE poll_id=NEW.poll_id AND id<>NEW.id AND withdrawn_at IS NULL
      AND (verified_at IS NOT NULL OR invited_at IS NOT NULL OR pending_expires_at>checked_at);
    IF total>=40 THEN
      RAISE EXCEPTION 'poll enrollment limit' USING ERRCODE='23514',CONSTRAINT='meeting_poll_voters_enrollment_cap';
    END IF;
  END IF;
  IF NEW.pending_expires_at>checked_at THEN
    SELECT count(*) INTO total FROM meeting_poll_voters WHERE poll_id=NEW.poll_id AND id<>NEW.id
      AND pending_expires_at>checked_at AND admission_ip_digest=NEW.admission_ip_digest;
    IF total>=3 THEN
      RAISE EXCEPTION 'poll pending IP limit' USING ERRCODE='23514',CONSTRAINT='meeting_poll_voters_ip_cap';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meeting_poll_voters_guard BEFORE INSERT OR UPDATE ON meeting_poll_voters
  FOR EACH ROW EXECUTE FUNCTION guard_meeting_poll_voter();

CREATE FUNCTION guard_meeting_poll_capability() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE deadline timestamptz; pending timestamptz;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.organization_id,NEW.poll_id,NEW.voter_id,NEW.purpose,NEW.expires_at)
    IS NOT DISTINCT FROM (OLD.organization_id,OLD.poll_id,OLD.voter_id,OLD.purpose,OLD.expires_at) THEN
    RETURN NEW;
  END IF;
  SELECT p.deadline_at,v.pending_expires_at INTO deadline,pending FROM meeting_polls p
    JOIN meeting_poll_voters v ON v.poll_id=p.id AND v.organization_id=p.organization_id
    WHERE p.id=NEW.poll_id AND p.organization_id=NEW.organization_id AND v.id=NEW.voter_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.expires_at>deadline OR (NEW.purpose='verification' AND (pending IS NULL OR NEW.expires_at>pending))
    OR (NEW.purpose='voting' AND NEW.expires_at<>deadline) THEN
    RAISE EXCEPTION 'poll credential expiry does not match purpose' USING ERRCODE='23514',CONSTRAINT='meeting_poll_capabilities_expiry_cap';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meeting_poll_capabilities_guard BEFORE INSERT OR UPDATE ON meeting_poll_capabilities
  FOR EACH ROW EXECUTE FUNCTION guard_meeting_poll_capability();

-- Check once when linked. Subsequent ordinary booking lifecycle changes retain history.
CREATE FUNCTION check_meeting_poll_booking() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.status='scheduled' AND (TG_OP='INSERT' OR OLD.booking_id IS DISTINCT FROM NEW.booking_id) AND
    NOT EXISTS (SELECT FROM bookings b JOIN meeting_poll_slots s ON s.id=NEW.chosen_slot_id
      AND s.organization_id=NEW.organization_id AND s.poll_id=NEW.id
      WHERE b.id=NEW.booking_id AND b.organization_id=NEW.organization_id
        AND b.event_type_id=NEW.event_type_id AND b.start_at=s.start_at AND b.end_at=s.end_at) THEN
    RAISE EXCEPTION 'poll booking does not match chosen event and interval' USING ERRCODE='23514',CONSTRAINT='meeting_polls_booking_match';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER meeting_polls_booking_match AFTER INSERT OR UPDATE ON meeting_polls
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_meeting_poll_booking();

CREATE FUNCTION retain_meeting_poll_tombstones() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE meeting_poll_operations SET poll_id=NULL,booking_id=NULL,
    purge_at=clock_timestamp()+interval '90 days',updated_at=clock_timestamp() WHERE poll_id=OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER meeting_polls_tombstones BEFORE DELETE ON meeting_polls
  FOR EACH ROW EXECUTE FUNCTION retain_meeting_poll_tombstones();

-- Deleting booking history also erases its poll's personal data before FK checks.
CREATE FUNCTION delete_booking_meeting_poll() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  DELETE FROM meeting_polls WHERE booking_id=OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER bookings_meeting_poll_privacy BEFORE DELETE ON bookings
  FOR EACH ROW EXECUTE FUNCTION delete_booking_meeting_poll();

-- Once scheduled, the original event/interval link is historical, even when the
-- ordinary booking is later moved or canceled. Personal data is erased by DELETE.
CREATE FUNCTION protect_meeting_poll_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.status='scheduled' AND (NEW.status,NEW.event_type_id,NEW.chosen_slot_id,NEW.booking_id,NEW.scheduled_at)
    IS DISTINCT FROM (OLD.status,OLD.event_type_id,OLD.chosen_slot_id,OLD.booking_id,OLD.scheduled_at) THEN
    RAISE EXCEPTION 'scheduled poll history is immutable' USING ERRCODE='23514',CONSTRAINT='meeting_polls_history_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meeting_polls_history BEFORE UPDATE ON meeting_polls
  FOR EACH ROW EXECUTE FUNCTION protect_meeting_poll_history();
