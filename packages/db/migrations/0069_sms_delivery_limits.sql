-- Internal SMS dispatch reservations, not a reminder queue. A reservation commits
-- before provider I/O. Only definite rate limits can retry; uncertain outcomes cannot resend.
CREATE TABLE sms_deliveries (
  key_hash bytea PRIMARY KEY CHECK (octet_length(key_hash) = 32),
  request_hash bytea CHECK (request_hash IS NULL OR octet_length(request_hash) = 32),
  recipient_hash bytea CHECK (recipient_hash IS NULL OR octet_length(recipient_hash) = 32),
  recipient_mask text,
  organization_id uuid,
  provider_message_id text,
  status text NOT NULL CHECK (status IN ('dispatching','accepted','failed','unknown','rate_limited','expired')),
  retry_not_before timestamptz,
  CHECK ((status = 'rate_limited') = (retry_not_before IS NOT NULL)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'expired' AND num_nonnulls(request_hash,recipient_hash,recipient_mask,organization_id,provider_message_id) = 0)
    OR (status <> 'expired' AND num_nonnulls(request_hash,recipient_hash,recipient_mask,organization_id) = 4)),
  CHECK (recipient_mask IS NULL OR recipient_mask ~ '^\+\*{4}[0-9]{2}$'),
  CHECK (provider_message_id IS NULL OR status = 'accepted')
);
-- No FK/cascade: deleting an organization must not erase dispatch deduplication.
CREATE INDEX sms_deliveries_recent ON sms_deliveries(created_at) WHERE status <> 'expired';
CREATE INDEX sms_deliveries_recipient ON sms_deliveries(recipient_hash,created_at) WHERE recipient_hash IS NOT NULL;
CREATE INDEX sms_deliveries_organization ON sms_deliveries(organization_id,created_at) WHERE organization_id IS NOT NULL;
