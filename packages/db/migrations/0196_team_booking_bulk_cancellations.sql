-- Scope and proof storage for the hard-off bulk cancellation feature.
-- The preview ID is reserved for use as the batch ID during later admission.
-- Actor and session IDs are historical, and a selected booking may disappear
-- between preview and execution, so only the organization and batch have FKs.
CREATE TABLE team_booking_bulk_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT team_booking_bulk_cancellations_expiry_check
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);

CREATE INDEX team_booking_bulk_cancellations_organization_idx
  ON team_booking_bulk_cancellations (organization_id);

CREATE TABLE team_booking_bulk_cancellation_items (
  batch_id uuid REFERENCES team_booking_bulk_cancellations (id) ON DELETE CASCADE,
  ordinal smallint CHECK (ordinal BETWEEN 1 AND 25),
  booking_id uuid NOT NULL,
  preview_outcome text NOT NULL CHECK (preview_outcome IN (
    'eligible', 'already_cancelled', 'booking_started', 'booking_not_supported',
    'booking_unavailable', 'booking_host_departed'
  )),
  PRIMARY KEY (batch_id, ordinal),
  UNIQUE (batch_id, booking_id)
);
