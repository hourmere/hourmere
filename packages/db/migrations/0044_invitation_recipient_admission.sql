-- Keep invitation admission accounting separate from actual outgoing mail. Existing
-- request rows lack an address/hash, so retain their inviter/team counts unchanged.
-- Their recipient history cannot be reconstructed without storing an address; the
-- recipient window starts with the new admission code and fills within 24 hours.
ALTER TABLE public.invitation_email_requests ADD COLUMN recipient_hash bytea;
CREATE INDEX invitation_email_requests_recipient_time
  ON public.invitation_email_requests (recipient_hash, requested_at);
