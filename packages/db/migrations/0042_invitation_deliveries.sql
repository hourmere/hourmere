-- Delivery state is independent of Better Auth's invitation lifecycle. Only the
-- current generation is retained; no address, link, credential or SMTP text is copied.
CREATE TABLE public.invitation_deliveries (
  invitation_id uuid PRIMARY KEY REFERENCES auth.invitation (id) ON DELETE CASCADE,
  generation integer NOT NULL DEFAULT 1,
  state text NOT NULL,
  attempts smallint NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_id uuid,
  lease_until timestamptz,
  last_job_id uuid,
  resend_request_id uuid,
  smtp_accepted_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT invitation_deliveries_generation CHECK (generation BETWEEN 1 AND 32),
  CONSTRAINT invitation_deliveries_state CHECK (
    state IN ('queued', 'sending', 'smtp_accepted', 'failed', 'skipped')
  ),
  CONSTRAINT invitation_deliveries_attempts CHECK (attempts BETWEEN 0 AND 4),
  CONSTRAINT invitation_deliveries_error_code CHECK (last_error_code IN (
    'transport_error', 'smtp_auth', 'smtp_temporary', 'smtp_permanent', 'smtp_not_configured',
    'mail_rate_limited', 'interrupted', 'attempts_exhausted', 'invitation_ineligible',
    'legacy_delivery_unknown'
  )),
  CONSTRAINT invitation_deliveries_lease CHECK (
    (state = 'sending' AND lease_id IS NOT NULL AND lease_until IS NOT NULL AND attempts > 0)
    OR (state <> 'sending' AND lease_id IS NULL AND lease_until IS NULL)
  ),
  CONSTRAINT invitation_deliveries_smtp_accepted CHECK (
    (state = 'smtp_accepted') = (smtp_accepted_at IS NOT NULL)
  ),
  CONSTRAINT invitation_deliveries_terminal_error CHECK (
    state NOT IN ('failed', 'skipped') OR last_error_code IS NOT NULL
  )
);

CREATE INDEX invitation_deliveries_due_idx
  ON public.invitation_deliveries (due_at, invitation_id)
  WHERE state IN ('queued', 'sending');

-- Historic outcomes are unknown. Keep a terminal tombstone until an authorized
-- explicit resend rather than silently sending every retained invitation again.
INSERT INTO public.invitation_deliveries (invitation_id, state, last_error_code)
SELECT id, 'failed', 'legacy_delivery_unknown' FROM auth.invitation
WHERE status = 'pending' AND "expiresAt" > CURRENT_TIMESTAMP;
