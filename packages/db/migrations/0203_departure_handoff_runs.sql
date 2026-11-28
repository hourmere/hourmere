CREATE TABLE departure_handoff_runs (
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  id uuid NOT NULL,
  departing_user_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'running',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_item_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  failure_code text,
  CONSTRAINT departure_handoff_runs_pkey PRIMARY KEY (organization_id, id),
  CONSTRAINT departure_handoff_runs_state_check CHECK (
    state IS NULL OR CASE state
      WHEN 'running' THEN finished_at IS NULL AND failure_code IS NULL
      WHEN 'paused' THEN finished_at IS NULL AND failure_code IS NULL
      WHEN 'stopped' THEN finished_at IS NOT NULL AND failure_code IS NULL
      WHEN 'completed' THEN finished_at IS NOT NULL AND failure_code IS NULL
      WHEN 'failed' THEN finished_at IS NOT NULL AND failure_code IS NOT NULL
        AND failure_code IN ('departed_member_returned', 'authorization_lost', 'run_expired')
      ELSE false
    END
  ),
  CONSTRAINT departure_handoff_runs_time_check CHECK (
    isfinite(created_at) AND isfinite(next_item_at) AND isfinite(expires_at)
    AND next_item_at >= created_at AND expires_at > created_at
    AND (finished_at IS NULL OR (isfinite(finished_at) AND finished_at >= created_at))
  )
);

CREATE UNIQUE INDEX departure_handoff_runs_one_active
  ON departure_handoff_runs (organization_id) WHERE state IN ('running', 'paused');
CREATE INDEX departure_handoff_runs_team_created_idx
  ON departure_handoff_runs (organization_id, created_at DESC);
CREATE INDEX departure_handoff_runs_due_idx
  ON departure_handoff_runs (next_item_at, organization_id, id) WHERE state = 'running';
CREATE INDEX departure_handoff_runs_expiry_idx
  ON departure_handoff_runs (expires_at, organization_id, id) WHERE state IN ('running', 'paused');
CREATE INDEX departure_handoff_runs_retention_idx
  ON departure_handoff_runs (finished_at, organization_id, id) WHERE finished_at IS NOT NULL;

CREATE TABLE departure_handoff_run_items (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  ordinal smallint NOT NULL,
  -- Retain opaque historical identifiers when an offer or booking is purged.
  source_booking_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  offer_version integer NOT NULL,
  outcome text NOT NULL DEFAULT 'pending',
  replacement_booking_id uuid,
  CONSTRAINT departure_handoff_run_items_pkey PRIMARY KEY (organization_id, run_id, ordinal),
  CONSTRAINT departure_handoff_run_items_run_fk FOREIGN KEY (organization_id, run_id)
    REFERENCES departure_handoff_runs (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT departure_handoff_run_items_source_key UNIQUE (organization_id, run_id, source_booking_id),
  CONSTRAINT departure_handoff_run_items_ordinal_check CHECK (ordinal BETWEEN 1 AND 10),
  CONSTRAINT departure_handoff_run_items_offer_version_check CHECK (offer_version > 0),
  CONSTRAINT departure_handoff_run_items_outcome_check CHECK (
    outcome IS NULL OR CASE outcome
      WHEN 'applied' THEN replacement_booking_id IS NOT NULL AND replacement_booking_id <> source_booking_id
      WHEN 'pending' THEN replacement_booking_id IS NULL
      WHEN 'ineligible' THEN replacement_booking_id IS NULL
      WHEN 'processing_failed' THEN replacement_booking_id IS NULL
      WHEN 'stopped' THEN replacement_booking_id IS NULL
      ELSE false
    END
  )
);

CREATE INDEX departure_handoff_offers_run_candidates_idx
  ON departure_handoff_offers (organization_id, departing_user_id, expires_at, source_booking_id)
  WHERE state = 'live';
