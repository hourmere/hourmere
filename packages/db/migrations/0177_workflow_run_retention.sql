SET LOCAL lock_timeout = '5s';

-- Keep the enrollment replay fence and let the existing FK cascade remove the claims.
-- Match the worker and history read window (WORKFLOW_HISTORY_DAYS) in elapsed hours.
CREATE OR REPLACE FUNCTION guard_workflow_run() RETURNS trigger
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
    IF OLD.state IN ('completed', 'skipped', 'retired')
       AND OLD.finished_at < transaction_timestamp() - interval '720 hours'
       AND NOT EXISTS (SELECT FROM public.workflow_recipient_claims
         WHERE organization_id = OLD.organization_id AND run_id = OLD.id
           AND booking_id = OLD.booking_id AND state = 'dispatching')
       AND NOT EXISTS (SELECT FROM public.webhook_deliveries
         WHERE organization_id = OLD.organization_id AND workflow_run_id = OLD.id
           AND booking_id = OLD.booking_id AND status = 'pending') THEN
      RETURN OLD;
    END IF;
    IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)
       AND EXISTS (SELECT FROM public.workflow_enrollments WHERE id = OLD.enrollment_id) THEN
      RAISE EXCEPTION 'a workflow run outside retention is removed only with its enrollment or organization'
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

CREATE INDEX workflow_runs_retention ON workflow_runs (finished_at, id)
  WHERE finished_at IS NOT NULL;

-- Pending workflow webhook deliveries still use their run for eligibility and audit.
CREATE INDEX webhook_deliveries_workflow_run_pending ON webhook_deliveries (workflow_run_id)
  WHERE status = 'pending' AND workflow_run_id IS NOT NULL;
