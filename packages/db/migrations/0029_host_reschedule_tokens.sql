-- Host moves transfer the invitee's existing hash to the successor in one transaction.
-- The predecessor keeps no hash; the unique constraint still prevents token reuse.
ALTER TABLE bookings ALTER COLUMN manage_token_hash DROP NOT NULL;
