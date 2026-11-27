-- A null user identifies the organization's SCIM invitation budget. Historical
-- admissions have no durable source and retain their original user until they age out.
ALTER TABLE public.invitation_email_requests ALTER COLUMN user_id DROP NOT NULL;

-- Record the source of the current delivery generation. Ordinary resends replace it.
ALTER TABLE public.invitation_deliveries ADD COLUMN scim_issued boolean NOT NULL DEFAULT false;
UPDATE public.invitation_deliveries AS delivery
SET scim_issued = true
FROM auth.invitation AS invitation
WHERE delivery.invitation_id = invitation.id
  AND delivery.generation = 1
  AND delivery.resend_request_id IS NULL
  AND invitation.status = 'pending'
  AND invitation."expiresAt" > CURRENT_TIMESTAMP
  AND EXISTS (
    SELECT 1
    FROM public.audit_events AS event
    WHERE event.organization_id = invitation."organizationId"
      AND event.actor_type = 'scim_token'
      AND event.action = 'membership.invited'
      AND event.target_type = 'invitation'
      AND event.target_id = invitation.id::text
      AND event.occurred_at >= invitation."createdAt"
  );

-- Attribute invitation journal events to the stable connection rather than a
-- rotating credential. Preserve all historical token and other actor rows.
ALTER TABLE public.audit_events DROP CONSTRAINT audit_events_actor_type_check;
ALTER TABLE public.audit_events ADD CONSTRAINT audit_events_actor_type_check CHECK (actor_type IN
  ('user','api_key','oauth_client','system','anonymous','external_api_key','external_oauth_client','external_user','scim_token','scim_connection'));
ALTER TABLE public.audit_events ADD CONSTRAINT audit_scim_connection_actor_credential CHECK (
  actor_type <> 'scim_connection' OR credential_type = 'none'
);
