-- A deleted poll's receipts keep only pseudonymous replay identity. Only create replays read
-- a tombstone; invite, resend, rotate-link and finalize lock the poll first and get
-- poll_not_found, so their request fingerprints (an invite's covers invitee names and
-- mailboxes) are replaced by a constant that no SHA-256 request digest equals. The rows stay
-- until purge_at, so a reused key still gets idempotency_key_reused.
CREATE OR REPLACE FUNCTION retain_meeting_poll_tombstones() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE meeting_poll_operations SET poll_id=NULL,booking_id=NULL,
    request_fingerprint=CASE WHEN operation='create' THEN request_fingerprint
      ELSE '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea END,
    purge_at=clock_timestamp()+interval '90 days',updated_at=clock_timestamp() WHERE poll_id=OLD.id;
  RETURN OLD;
END $$;

-- Tombstones written before this migration.
UPDATE meeting_poll_operations
  SET request_fingerprint='\x0000000000000000000000000000000000000000000000000000000000000000'::bytea
  WHERE poll_id IS NULL AND operation<>'create'
    AND request_fingerprint<>'\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
