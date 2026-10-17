-- Hidden event types remain bookable by direct link but do not appear on a host page.
-- Existing event types stay listed. This is discovery control, not an access credential.
ALTER TABLE event_types ADD COLUMN is_hidden boolean NOT NULL DEFAULT false;
