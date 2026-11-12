-- Booking workflow execution storage (docs/workflows.md, step 3 of the implementation plan):
-- enrollments, due runs, per-recipient claims, minimal history and workflow mail reservations,
-- plus the workflow reservation column of the shared mail ledger. Storage only: no route,
-- worker, read path or setting uses them yet, and workflows stay hard-off behind
-- WORKFLOWS_IMPLEMENTED = false.
--
-- Each child row carries its organization in a composite foreign key, as workflow revisions do,
-- and its guard locks the organization before any parent row; reservations, which have no
-- parent row, reference the organization directly.
--
-- Execution identity outlives a definition's content. Enrollments name their workflow and
-- revision without a foreign key to the definition, so purging a tombstoned definition with its
-- revisions keeps every booking's enrollment, run and recipient claim: replayed capture or
-- repair meets the same unique identity and cannot dispatch again. These rows hold identity,
-- timing and fixed codes, never definition content, rendered text or addresses, and they go
-- only with their booking or organization. A purge is refused while the workflow has an
-- unfinished run, and no enrollment or run is added for a tombstoned or purged workflow.

-- A booking's capture of one workflow revision at one lifecycle occurrence: its creation (timer
-- and creation triggers; a reschedule successor carries its timer enrollments under this
-- occurrence with their captured revision), its reschedule or its cancellation. Immutable, and
-- unique per booking, occurrence and workflow, so a replayed or concurrent capture coalesces.
CREATE TABLE workflow_enrollments (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  revision integer NOT NULL,
  occurrence text NOT NULL,
  trigger text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_enrollments_identity UNIQUE (booking_id, occurrence, workflow_id),
  CONSTRAINT workflow_enrollments_booking_key UNIQUE (organization_id, id, booking_id),
  CONSTRAINT workflow_enrollments_booking FOREIGN KEY (booking_id, organization_id)
    REFERENCES bookings (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT workflow_enrollments_occurrence CHECK (
    (occurrence = 'created' AND trigger IN ('booking.created', 'before_start', 'after_end'))
    OR (occurrence = 'rescheduled' AND trigger IN ('booking.rescheduled'))
    OR (occurrence = 'cancelled' AND trigger IN ('booking.cancelled'))
  )
);
CREATE INDEX workflow_enrollments_workflow ON workflow_enrollments (organization_id, workflow_id);

-- An enrollment locks the organization and then its definition, which must be live and hold
-- the named revision with that trigger. The definition's share lock makes a capture and the
-- workflow's deletion take turns. Enrollments are never changed, and are removed only with
-- their booking or organization.
CREATE FUNCTION guard_workflow_enrollment() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM FROM auth.organization WHERE id = NEW.organization_id FOR KEY SHARE;
    PERFORM FROM public.workflow_definitions
      WHERE organization_id = NEW.organization_id AND id = NEW.workflow_id
        AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a booking enrolls only in a live workflow'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_enrollments_live_workflow';
    END IF;
    IF NOT EXISTS (SELECT FROM public.workflow_revisions
        WHERE organization_id = NEW.organization_id AND workflow_id = NEW.workflow_id
          AND revision = NEW.revision AND definition->'trigger'->>'type' = NEW.trigger) THEN
      RAISE EXCEPTION 'an enrollment names a stored revision and its trigger'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_enrollments_revision';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'workflow enrollments are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_enrollments_immutable';
  END IF;
  IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)
     AND EXISTS (SELECT FROM public.bookings WHERE id = OLD.booking_id) THEN
    RAISE EXCEPTION 'a workflow enrollment is removed only with its booking or organization'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_enrollments_retained';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER workflow_enrollments_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_enrollments
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_enrollment();

-- The one due run of an enrollment (a revision has exactly one action), on the enrollment's
-- booking. Its due and expiry instants are decided at capture and never move: a reschedule
-- retires the run and its successor gets new ones. A worker claims it with a token and a
-- lease; completed, skipped and retired runs are final.
CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  skip_reason text,
  claim_token uuid,
  lease_until timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_runs_identity UNIQUE (enrollment_id),
  CONSTRAINT workflow_runs_booking_key UNIQUE (organization_id, id, booking_id),
  CONSTRAINT workflow_runs_enrollment FOREIGN KEY (organization_id, enrollment_id, booking_id)
    REFERENCES workflow_enrollments (organization_id, id, booking_id) ON DELETE CASCADE,
  CONSTRAINT workflow_runs_window CHECK (expires_at > due_at),
  CONSTRAINT workflow_runs_state CHECK ((
    CASE
      WHEN state = 'pending' THEN
        num_nonnulls(skip_reason, claim_token, lease_until, finished_at) = 0
      WHEN state = 'claimed' THEN
        claim_token IS NOT NULL AND lease_until IS NOT NULL
        AND num_nonnulls(skip_reason, finished_at) = 0
      WHEN state IN ('completed', 'retired') THEN
        finished_at IS NOT NULL AND num_nonnulls(skip_reason, claim_token, lease_until) = 0
      WHEN state = 'skipped' THEN
        finished_at IS NOT NULL AND num_nonnulls(claim_token, lease_until) = 0
        AND skip_reason IN ('condition_false', 'existing_notification', 'minimum_gap',
          'offset_not_future', 'expired', 'budget_suppressed', 'render_limit',
          'workflow_disabled', 'instance_disabled')
      ELSE false
    END
  ) IS TRUE)
);
-- Bounded due work: the dispatcher and the repair scan read only unfinished runs.
CREATE INDEX workflow_runs_due ON workflow_runs (due_at, id) WHERE state IN ('pending', 'claimed');
CREATE TRIGGER workflow_runs_updated_at BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A run locks the organization and then its workflow's definition, which must be live, and
-- starts pending or skipped. Its identity and timing never change, a finished run is final,
-- and it is removed only with its enrollment or organization.
CREATE FUNCTION guard_workflow_run() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  workflow uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM FROM auth.organization WHERE id = NEW.organization_id FOR KEY SHARE;
    SELECT workflow_id INTO workflow FROM public.workflow_enrollments
      WHERE organization_id = NEW.organization_id AND id = NEW.enrollment_id;
    IF NOT FOUND THEN
      RETURN NEW; -- the foreign key reports the missing enrollment
    END IF;
    PERFORM FROM public.workflow_definitions
      WHERE organization_id = NEW.organization_id AND id = workflow AND deleted_at IS NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a run is added only for a live workflow'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_runs_live_workflow';
    END IF;
    IF NEW.state NOT IN ('pending', 'skipped') THEN
      RAISE EXCEPTION 'a workflow run starts pending or skipped'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_runs_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)
       AND EXISTS (SELECT FROM public.workflow_enrollments WHERE id = OLD.enrollment_id) THEN
      RAISE EXCEPTION 'a workflow run is removed only with its enrollment or organization'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_runs_retained';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.enrollment_id, NEW.booking_id, NEW.due_at,
         NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.enrollment_id, OLD.booking_id,
         OLD.due_at, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'a workflow run''s identity and timing are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_runs_immutable';
  END IF;
  IF OLD.state IN ('completed', 'skipped', 'retired') THEN
    RAISE EXCEPTION 'a finished workflow run is final'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_runs_final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_runs_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_run();

-- One recipient of an email run: an attendee or assigned host, and the workflow-purpose digest
-- of the normalized address (never the address). Unique per run and address, so a run sends at
-- most once to each address. A timer email's winning recipient also holds its intent
-- (category, offset, address) on the booking, which only one workflow can hold; a recipient
-- that loses the intent keeps no intent key. `dispatching` is the marker committed before SMTP
-- with the claim token of its attempt; sent, rejected, delivery_unknown and skipped are final.
CREATE TABLE workflow_recipient_claims (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  recipient text NOT NULL,
  recipient_hash bytea NOT NULL,
  intent_kind text,
  intent_offset_minutes integer,
  state text NOT NULL DEFAULT 'pending',
  skip_reason text,
  claim_token uuid,
  attempts smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_recipient_claims_identity UNIQUE (organization_id, run_id, recipient_hash),
  CONSTRAINT workflow_recipient_claims_intent
    UNIQUE (booking_id, intent_kind, intent_offset_minutes, recipient_hash),
  CONSTRAINT workflow_recipient_claims_run FOREIGN KEY (organization_id, run_id, booking_id)
    REFERENCES workflow_runs (organization_id, id, booking_id) ON DELETE CASCADE,
  CONSTRAINT workflow_recipient_claims_recipient CHECK (
    recipient ~ '^(attendee|host):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND octet_length(recipient_hash) = 32
  ),
  CONSTRAINT workflow_recipient_claims_intent_key CHECK ((
    (intent_kind IS NULL AND intent_offset_minutes IS NULL)
    OR (intent_kind IN ('before_start', 'after_end')
      AND intent_offset_minutes BETWEEN 5 AND 43200)
  ) IS TRUE),
  CONSTRAINT workflow_recipient_claims_state CHECK (attempts >= 0 AND (
    CASE
      WHEN state = 'pending' THEN num_nonnulls(skip_reason, claim_token, finished_at) = 0
      WHEN state = 'dispatching' THEN
        claim_token IS NOT NULL AND num_nonnulls(skip_reason, next_attempt_at, finished_at) = 0
      WHEN state IN ('sent', 'rejected', 'delivery_unknown') THEN
        finished_at IS NOT NULL AND num_nonnulls(skip_reason, claim_token, next_attempt_at) = 0
      WHEN state = 'skipped' THEN
        finished_at IS NOT NULL AND num_nonnulls(claim_token, next_attempt_at) = 0
        AND skip_reason IN ('condition_false', 'existing_notification', 'minimum_gap',
          'offset_not_future', 'expired', 'budget_suppressed', 'render_limit',
          'workflow_disabled', 'instance_disabled')
      ELSE false
    END
  ) IS TRUE)
);
CREATE TRIGGER workflow_recipient_claims_updated_at BEFORE UPDATE ON workflow_recipient_claims
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Markers whose attempt may have stopped, for the repair that ends them, even under a run that
-- finished meanwhile.
CREATE INDEX workflow_recipient_claims_dispatching ON workflow_recipient_claims (updated_at, id)
  WHERE state = 'dispatching';

-- A recipient is claimed after the organization lock, only while its run is unfinished, and
-- starts pending or skipped. Its identity and intent never change and a finished claim is final.
-- It is marked dispatching only while its run is claimed: the marker shares the run, so a
-- retirement that commits first prevents the marker, and a marker that commits first holds the
-- retirement back until it has committed. A marker transaction locks the run before the
-- recipient, as retirement does. A claim is removed only with its run or organization.
CREATE FUNCTION guard_workflow_recipient_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  run_state text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM FROM auth.organization WHERE id = NEW.organization_id FOR KEY SHARE;
    SELECT state INTO run_state FROM public.workflow_runs
      WHERE organization_id = NEW.organization_id AND id = NEW.run_id FOR SHARE;
    IF FOUND AND run_state NOT IN ('pending', 'claimed') THEN
      RAISE EXCEPTION 'a recipient is claimed only for an unfinished run'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_recipient_claims_open_run';
    END IF;
    IF NEW.state NOT IN ('pending', 'skipped') THEN
      RAISE EXCEPTION 'a recipient claim starts pending or skipped'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_recipient_claims_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)
       AND EXISTS (SELECT FROM public.workflow_runs WHERE id = OLD.run_id) THEN
      RAISE EXCEPTION 'a recipient claim is removed only with its run or organization'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_recipient_claims_retained';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.run_id, NEW.booking_id, NEW.recipient,
         NEW.recipient_hash, NEW.intent_kind, NEW.intent_offset_minutes, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.run_id, OLD.booking_id,
         OLD.recipient, OLD.recipient_hash, OLD.intent_kind, OLD.intent_offset_minutes,
         OLD.created_at) THEN
    RAISE EXCEPTION 'a recipient claim''s identity and intent are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_recipient_claims_immutable';
  END IF;
  IF OLD.state IN ('sent', 'rejected', 'delivery_unknown', 'skipped') THEN
    RAISE EXCEPTION 'a finished recipient claim is final'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_recipient_claims_final';
  END IF;
  IF NEW.state = 'dispatching' AND OLD.state <> 'dispatching' THEN
    SELECT state INTO run_state FROM public.workflow_runs
      WHERE organization_id = NEW.organization_id AND id = NEW.run_id FOR SHARE;
    IF run_state IS DISTINCT FROM 'claimed' THEN
      RAISE EXCEPTION 'a recipient is marked dispatching only while its run is claimed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_recipient_claims_marker';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_recipient_claims_guard
  BEFORE INSERT OR UPDATE OR DELETE ON workflow_recipient_claims
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_recipient_claim();

-- Minimal history: one immutable record per finished run, with no booking, recipient, address,
-- payload or content; only the workflow, revision, trigger, times, outcome, a fixed reason and
-- aggregate recipient counts. It is not linked to the run, so it outlives the booking for its
-- retention window, and it goes with its workflow. Retention deletes it by finish time; the
-- run's identity stays with its booking.
CREATE TABLE workflow_run_history (
  run_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  revision integer NOT NULL,
  trigger text NOT NULL,
  due_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  outcome text NOT NULL,
  reason text,
  sent integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  delivery_unknown integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  CONSTRAINT workflow_run_history_workflow FOREIGN KEY (organization_id, workflow_id)
    REFERENCES workflow_definitions (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_run_history_trigger CHECK (trigger IN ('booking.created',
    'booking.cancelled', 'booking.rescheduled', 'before_start', 'after_end')),
  CONSTRAINT workflow_run_history_outcome CHECK ((
    revision >= 1
    AND least(sent, rejected, delivery_unknown, skipped) >= 0
    AND ((outcome IN ('completed', 'retired') AND reason IS NULL)
      OR (outcome = 'skipped' AND reason IN ('condition_false', 'existing_notification',
        'minimum_gap', 'offset_not_future', 'expired', 'budget_suppressed', 'render_limit',
        'workflow_disabled', 'instance_disabled')))
  ) IS TRUE)
);
-- A workflow's history pages, newest first, with the run as a stable tiebreaker.
CREATE INDEX workflow_run_history_page
  ON workflow_run_history (organization_id, workflow_id, finished_at, run_id);
CREATE INDEX workflow_run_history_retention ON workflow_run_history (finished_at);

CREATE FUNCTION guard_workflow_run_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM FROM auth.organization WHERE id = NEW.organization_id FOR KEY SHARE;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'workflow run history is immutable'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_run_history_immutable';
END $$;
CREATE TRIGGER workflow_run_history_guard BEFORE INSERT OR UPDATE ON workflow_run_history
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_run_history();

-- One reservation per admitted recipient claim, charged to the owner (the personal or team
-- organization). Its ledger row in notification_email_sends names it. Run and claim are named
-- without foreign keys, so deleting a workflow, booking or run never removes a charge. A known
-- not-sent retry restamps the reservation forward with its ledger row and never adds a second.
CREATE TABLE workflow_mail_reservations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  reserved_at timestamptz NOT NULL,
  CONSTRAINT workflow_mail_reservations_claim UNIQUE (claim_id)
);
-- The owner's sliding-hour count, and the cleanup sweep after the ledger's retention.
CREATE INDEX workflow_mail_reservations_owner
  ON workflow_mail_reservations (organization_id, reserved_at);
CREATE INDEX workflow_mail_reservations_retention ON workflow_mail_reservations (reserved_at);

CREATE FUNCTION guard_workflow_mail_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)
       AND EXISTS (SELECT FROM public.notification_email_sends
         WHERE workflow_reservation_id = OLD.id) THEN
      RAISE EXCEPTION 'a reservation stays while its ledger charge exists'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_mail_reservations_charged';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.run_id, NEW.claim_id)
     IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.run_id, OLD.claim_id) THEN
    RAISE EXCEPTION 'a reservation''s owner, run and claim are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_mail_reservations_immutable';
  END IF;
  IF NEW.reserved_at < OLD.reserved_at THEN
    RAISE EXCEPTION 'a reservation is restamped only forward'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_mail_reservations_restamp';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_mail_reservations_guard
  BEFORE UPDATE OR DELETE ON workflow_mail_reservations
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_mail_reservation();

-- The shared ledger names a workflow charge's reservation, without a foreign key, so deleting a
-- workflow, booking or team never removes a charge. Existing and core rows keep NULL: core
-- inserts and every core count query are unchanged, and the two-day purge still applies. A
-- workflow charge always counts against a recipient digest, and a reservation has at most one
-- ledger row.
ALTER TABLE notification_email_sends ADD COLUMN workflow_reservation_id uuid;
ALTER TABLE notification_email_sends ADD CONSTRAINT notification_email_sends_workflow_recipient
  CHECK (workflow_reservation_id IS NULL OR recipient_hash IS NOT NULL);
CREATE UNIQUE INDEX notification_email_sends_workflow_reservation
  ON notification_email_sends (workflow_reservation_id) WHERE workflow_reservation_id IS NOT NULL;

-- A definition's purge (deleting its tombstone with its revisions) is refused while one of its
-- runs is unfinished; with its organization or personal owner it always goes.
CREATE FUNCTION guard_workflow_definition_purge() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)
     AND (OLD.owner_user_id IS NULL
       OR EXISTS (SELECT FROM auth."user" WHERE id = OLD.owner_user_id))
     AND EXISTS (SELECT FROM public.workflow_enrollments e
       JOIN public.workflow_runs r ON r.enrollment_id = e.id
       WHERE e.organization_id = OLD.organization_id AND e.workflow_id = OLD.id
         AND r.state IN ('pending', 'claimed')) THEN
    RAISE EXCEPTION 'a workflow with unfinished runs is not purged'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_definitions_unfinished_runs';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER workflow_definitions_purge BEFORE DELETE ON workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_definition_purge();
