-- Minimal operation attribution, separate from booking creation/withdrawal origins.
-- Historical actors cannot be recovered safely, so existing rows are not backfilled.
CREATE TABLE organization_operations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('booking_cancelled', 'member_removed', 'member_role_changed')),
  -- Retain identity after account, API key or OAuth grant deletion. Anonymous private
  -- booking links have no authenticated actor; membership operations always do.
  actor_user_id uuid,
  booking_id uuid REFERENCES bookings (id) ON DELETE CASCADE,
  target_user_id uuid,
  previous_role text CHECK (char_length(previous_role) BETWEEN 1 AND 255),
  new_role text CHECK (char_length(new_role) BETWEEN 1 AND 255),
  source text NOT NULL CHECK (source IN ('web', 'embed', 'api', 'mcp')),
  api_key_id uuid,
  oauth_consent_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_operations_shape CHECK (
    (operation = 'booking_cancelled' AND booking_id IS NOT NULL AND target_user_id IS NULL
      AND previous_role IS NULL AND new_role IS NULL) OR
    (operation = 'member_removed' AND actor_user_id IS NOT NULL AND booking_id IS NULL
      AND target_user_id IS NOT NULL AND previous_role IS NOT NULL AND new_role IS NULL) OR
    (operation = 'member_role_changed' AND actor_user_id IS NOT NULL AND booking_id IS NULL
      AND target_user_id IS NOT NULL AND previous_role IS NOT NULL AND new_role IS NOT NULL)
  ),
  CONSTRAINT organization_operations_key_origin CHECK (
    api_key_id IS NULL OR source IN ('api', 'mcp')
  ),
  CONSTRAINT organization_operations_oauth_origin CHECK (
    oauth_consent_id IS NULL OR (source = 'mcp' AND api_key_id IS NULL)
  ),
  CONSTRAINT organization_operations_member_origin CHECK (
    operation = 'booking_cancelled' OR
      (source = 'web' AND api_key_id IS NULL AND oauth_consent_id IS NULL)
  )
);
CREATE UNIQUE INDEX organization_operations_booking_cancelled
  ON organization_operations (booking_id) WHERE operation = 'booking_cancelled';
CREATE INDEX organization_operations_organization_time
  ON organization_operations (organization_id, occurred_at DESC, id DESC);
