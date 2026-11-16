ALTER TABLE event_types ADD COLUMN sms_reminders_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE booking_attendees ADD COLUMN sms_consent boolean NOT NULL DEFAULT false;

-- Instance-wide keyed recipient hashes; never persist inbound phone numbers or bodies.
CREATE TABLE sms_suppressions (
  recipient_hash bytea PRIMARY KEY CHECK (octet_length(recipient_hash) = 32)
);
-- Permanent keyed MessageSid tombstones prevent a replayed START undoing a later STOP.
CREATE TABLE sms_inbound_receipts (
  key_hash bytea PRIMARY KEY CHECK (octet_length(key_hash) = 32)
);
ALTER TABLE booking_attendees ADD COLUMN sms_phone text;
ALTER TABLE bookings ADD COLUMN sms_reminders_enabled boolean NOT NULL DEFAULT false;
