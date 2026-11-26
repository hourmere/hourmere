ALTER TABLE public.team_booking_bulk_cancellations
  ADD COLUMN state text NOT NULL DEFAULT 'awaiting_confirmation',
  ADD COLUMN admitted_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD CONSTRAINT team_booking_bulk_cancellations_state_check CHECK (
    CASE state
      WHEN 'awaiting_confirmation' THEN admitted_at IS NULL AND completed_at IS NULL
      WHEN 'queued' THEN admitted_at IS NOT NULL AND completed_at IS NULL
      WHEN 'running' THEN admitted_at IS NOT NULL AND completed_at IS NULL
      WHEN 'completed' THEN admitted_at IS NOT NULL AND completed_at IS NOT NULL
        AND completed_at >= admitted_at
      ELSE false
    END
    AND (admitted_at IS NULL OR (admitted_at >= created_at AND admitted_at < expires_at))
  );

CREATE UNIQUE INDEX team_booking_bulk_cancellations_active_team_idx
  ON public.team_booking_bulk_cancellations (organization_id)
  WHERE state IN ('queued', 'running');

CREATE INDEX team_booking_bulk_cancellations_admissions_idx
  ON public.team_booking_bulk_cancellations (organization_id, admitted_at)
  WHERE admitted_at IS NOT NULL;

CREATE INDEX team_booking_bulk_cancellations_preview_expiry_idx
  ON public.team_booking_bulk_cancellations (expires_at, id)
  WHERE state = 'awaiting_confirmation';

CREATE INDEX team_booking_bulk_cancellations_completed_retention_idx
  ON public.team_booking_bulk_cancellations (completed_at, id)
  WHERE state = 'completed';

ALTER TABLE public.team_booking_bulk_cancellation_items
  ADD COLUMN outcome text,
  ADD COLUMN attempt_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_expires_at timestamptz,
  ADD CONSTRAINT team_booking_bulk_items_outcome_check CHECK (
    outcome IS NULL
    OR (preview_outcome <> 'eligible' AND outcome = preview_outcome)
    OR (preview_outcome = 'eligible' AND outcome IN (
      'pending', 'cancelled', 'already_cancelled', 'booking_started',
      'booking_not_supported', 'booking_unavailable', 'booking_host_departed',
      'authorization_lost', 'processing_failed'
    ))
  ),
  ADD CONSTRAINT team_booking_bulk_items_attempt_count_check CHECK (attempt_count BETWEEN 0 AND 3),
  ADD CONSTRAINT team_booking_bulk_items_due_check CHECK (
    (outcome IS NOT DISTINCT FROM 'pending') = (next_attempt_at IS NOT NULL)
  ),
  ADD CONSTRAINT team_booking_bulk_items_claim_check CHECK (
    (claim_token IS NULL AND claim_expires_at IS NULL)
    OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
      AND outcome IS NOT DISTINCT FROM 'pending' AND attempt_count > 0)
  );

CREATE UNIQUE INDEX team_booking_bulk_items_active_claim_idx
  ON public.team_booking_bulk_cancellation_items (batch_id)
  WHERE claim_token IS NOT NULL;

CREATE TABLE public.team_booking_bulk_request_limits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('preview', 'status')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX team_booking_bulk_request_limits_team_idx
  ON public.team_booking_bulk_request_limits (organization_id, kind, created_at);

CREATE INDEX team_booking_bulk_request_limits_actor_idx
  ON public.team_booking_bulk_request_limits (organization_id, kind, actor_user_id, created_at);

CREATE INDEX team_booking_bulk_request_limits_cleanup_idx
  ON public.team_booking_bulk_request_limits (created_at, id);

-- Capture the installed predecessor check exactly. Several earlier migrations add
-- journal branches. Using the live expression preserves each branch and its bindings.
-- The helper takes a row because prior checks can refer to the actor and target too.
LOCK TABLE public.audit_events IN ACCESS EXCLUSIVE MODE;
DO $capture$
DECLARE
  predecessor_check text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT predecessor_check
  FROM pg_constraint
  WHERE conrelid = 'public.audit_events'::regclass
    AND conname = 'audit_events_details_check' AND contype = 'c' AND convalidated;

  EXECUTE format($definition$
    CREATE FUNCTION public.audit_event_pre_bulk_details_valid(prior_event public.audit_events)
    RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
    SET search_path = pg_catalog
    RETURN (SELECT %s FROM (SELECT (prior_event).*) AS previous_event)
  $definition$, predecessor_check);
END;
$capture$;

CREATE FUNCTION public.team_booking_bulk_audit_counts_valid(counts jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
RETURN CASE WHEN jsonb_typeof(counts) = 'object' THEN
  counts ?& ARRAY[
    'pending', 'cancelled', 'already_cancelled', 'booking_started', 'booking_not_supported',
    'booking_unavailable', 'booking_host_departed', 'authorization_lost', 'processing_failed'
  ]
  AND counts - ARRAY[
    'pending', 'cancelled', 'already_cancelled', 'booking_started', 'booking_not_supported',
    'booking_unavailable', 'booking_host_departed', 'authorization_lost', 'processing_failed'
  ] = '{}'::jsonb
  AND counts->'pending' = '0'::jsonb
  AND (SELECT bool_and(n IS NOT NULL) AND sum(n) BETWEEN 1 AND 25
       FROM (
         SELECT CASE WHEN jsonb_typeof(value) = 'number'
           AND value #>> '{}' ~ '^(0|[1-9]|1[0-9]|2[0-5])$'
           THEN (value #>> '{}')::int END AS n
         FROM jsonb_each(counts)
       ) AS bounded)
ELSE false END;

ALTER TABLE public.audit_events DROP CONSTRAINT audit_events_details_check;
ALTER TABLE public.audit_events ADD CONSTRAINT audit_events_details_check
  CHECK (
    CASE action
      WHEN 'booking.bulk_cancellation_admitted' THEN
        CASE WHEN jsonb_typeof(details) = 'object' THEN
          details - 'selectedCount' = '{}'::jsonb
          AND coalesce(jsonb_typeof(details->'selectedCount') = 'number'
            AND details->>'selectedCount' ~ '^([1-9]|1[0-9]|2[0-5])$', false)
        ELSE false END
      WHEN 'booking.bulk_cancellation_completed' THEN
        CASE WHEN jsonb_typeof(details) = 'object' THEN
          details - 'counts' = '{}'::jsonb
          AND coalesce(public.team_booking_bulk_audit_counts_valid(details->'counts'), false)
        ELSE false END
      ELSE public.audit_event_pre_bulk_details_valid(audit_events.*)
    END
  );
