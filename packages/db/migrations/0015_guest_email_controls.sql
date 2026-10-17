-- New guest recipients require an explicit host choice, including on existing event types.
-- Existing booking_attendees rows remain intact for updates, reminders and cancellations.
ALTER TABLE event_types ADD COLUMN allow_guests boolean NOT NULL DEFAULT false;
