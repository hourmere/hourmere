ALTER TABLE webhooks
    ADD COLUMN destination_kind text NOT NULL DEFAULT 'webhook' CHECK (destination_kind IN ('webhook', 'slack')),
    ADD COLUMN url_ciphertext bytea,
    ADD COLUMN event_type_id uuid,
    ADD COLUMN pause_reason text,
    ADD CONSTRAINT slack_event_type_organization FOREIGN KEY (event_type_id, organization_id) REFERENCES event_types(id, organization_id) ON DELETE CASCADE,
    ADD CONSTRAINT slack_url_encrypted CHECK ((destination_kind = 'slack') = (url_ciphertext IS NOT NULL)),
    ADD CONSTRAINT slack_pause_reason CHECK (pause_reason IS NULL OR (pause_reason = 'url_rejected' AND destination_kind = 'slack' AND NOT is_active));
CREATE UNIQUE INDEX webhooks_one_slack_per_organization ON webhooks (organization_id) WHERE destination_kind = 'slack';
ALTER TABLE webhook_deliveries ALTER COLUMN booking_id DROP NOT NULL;
