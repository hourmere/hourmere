-- Queued login links are credentials: the job contains only the row id, while this
-- short-lived outbox stores authenticated ciphertext bound to that id and PUBLIC_URL.
-- Both authorized and disallowed addresses take exactly this path; delivery eligibility
-- is checked only by the worker. Expired rows are removed by its periodic cleanup.
CREATE TABLE sign_in_emails (
  id uuid PRIMARY KEY,
  encrypted_payload bytea NOT NULL CHECK (octet_length(encrypted_payload) BETWEEN 30 AND 1048576),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sign_in_emails_expiry ON sign_in_emails (expires_at);
