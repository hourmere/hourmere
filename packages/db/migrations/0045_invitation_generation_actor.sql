-- The original inviter remains the sign-up trust source. Each mail generation
-- records its own authorizing administrator for authority checks and attribution.
-- NULL preserves legacy generations without rewriting their delivery metadata.
-- Keep the UUID after account deletion: the sender must refuse that missing actor,
-- rather than fall back to the original inviter or discard delivery history.
ALTER TABLE public.invitation_deliveries
  ADD COLUMN authorized_by_user_id uuid;
