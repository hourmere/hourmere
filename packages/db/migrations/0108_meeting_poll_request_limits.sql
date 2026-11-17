-- Shared transport budgets retain only a purpose-bound IP digest and a short window.
CREATE TABLE meeting_poll_request_limits (
  key_digest bytea PRIMARY KEY,
  hits integer NOT NULL,
  reset_at timestamptz NOT NULL,
  CONSTRAINT meeting_poll_request_limits_digest_length CHECK (octet_length(key_digest) = 32),
  CONSTRAINT meeting_poll_request_limits_positive_hits CHECK (hits > 0)
);
