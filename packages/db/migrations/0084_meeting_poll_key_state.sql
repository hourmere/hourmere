-- The meeting-poll key fence (docs/meeting-polls.md, Installation secret and key fence).
-- Meeting-poll mailbox digests, admission IP digests and retained credential ciphertexts are
-- derived from the installation's meeting-poll secret. One row records a keyed fingerprint of
-- the secret that data was written under; the secret itself is never stored. The voter
-- services record a secret only while no keyed data exists and refuse any other secret
-- otherwise. This migration writes no row: the first use after it records the key.
CREATE TABLE meeting_poll_key_state (
  singleton boolean PRIMARY KEY DEFAULT true,
  secret_fingerprint bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_poll_key_state_singleton CHECK (singleton),
  CONSTRAINT meeting_poll_key_state_fingerprint_length CHECK (octet_length(secret_fingerprint) = 32)
);
