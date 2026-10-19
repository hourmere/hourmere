-- A provider-acknowledged request that stays pending is distinct from transport
-- failure. Keep historical failures unchanged: their exact cause is unknowable.
ALTER TABLE booking_conferences DROP CONSTRAINT booking_conferences_error_code_check;
ALTER TABLE booking_conferences ADD CONSTRAINT booking_conferences_error_code_check CHECK
 (error_code IN ('disabled','calendar_unavailable','needs_reauth','permissions_missing','provider_unavailable','ambiguous_create','conference_failed','conference_pending_timeout','invalid_response','meeting_started','organizer_unavailable'));

-- Request identity plus conference_patch_request_id already determine whether a
-- conference PATCH is needed. This flag was only written, never consumed.
ALTER TABLE booking_conferences DROP COLUMN retry_conference;
