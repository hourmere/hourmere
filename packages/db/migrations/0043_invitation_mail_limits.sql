-- Admission accounting survives deleting an invitation, team or inviter. No address
-- is stored here; recipient admission hashes are added by the next migration.
CREATE TABLE public.invitation_email_requests (
  user_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  requested_at timestamptz NOT NULL
);
CREATE INDEX invitation_email_requests_user_time
  ON public.invitation_email_requests (user_id, requested_at);
CREATE INDEX invitation_email_requests_organization_time
  ON public.invitation_email_requests (organization_id, requested_at);
CREATE INDEX invitation_email_requests_time
  ON public.invitation_email_requests (requested_at);

-- Record generation start alongside delivery updates for the resend cooldown. Pin the
-- original validity so explicit resend extends expiry without growing that interval.
-- Earlier production invitations always used Better Auth's default 48-hour validity.
-- Native resend changed expiresAt without changing createdAt, so their difference
-- cannot recover that interval. Preserve both fields and pin the known default.
ALTER TABLE public.invitation_deliveries
  ADD COLUMN generation_started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN expiry_duration_ms bigint NOT NULL DEFAULT 172800000,
  ADD CONSTRAINT invitation_deliveries_expiry_duration CHECK (expiry_duration_ms > 0);
UPDATE public.invitation_deliveries AS delivery
  SET generation_started_at = delivery.created_at,
      expiry_duration_ms = 172800000;
