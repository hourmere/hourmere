-- Booking workflow creation keys (docs/workflows.md, step 5 of the implementation plan): the
-- retained client idempotency key of a definition that a create request made, and a fingerprint
-- of that request's canonical input, so a replay with the same input returns that definition
-- and a changed input under the same key conflicts. Storage only: nothing reads or writes it
-- yet, and workflows stay hard-off behind WORKFLOWS_IMPLEMENTED = false.
--
-- A key is scoped to the definition's organization, the acting user and the credential that
-- made the request, by kind: a session principal (the user, with no credential record), an API
-- key or an OAuth consent (its record ID). Kinds never share a scope, and NULLS NOT DISTINCT
-- keeps a session principal's keys unique too, so two concurrent creates with one key write
-- once. The actor and credential IDs are historical identifiers without foreign keys, as
-- bookings keep theirs: deleting an API key, OAuth consent, session or user leaves the row
-- unchanged, and no later credential or user can match it, because none gets the same random
-- ID. A key lives as long as its definition row, tombstone included, and goes with it when the
-- tombstone is purged, or with its organization or personal owner.
CREATE TABLE workflow_creation_keys (
  organization_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  credential_kind text NOT NULL,
  credential_id uuid,
  idempotency_key text NOT NULL,
  request_fingerprint bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workflow_id),
  CONSTRAINT workflow_creation_keys_scope UNIQUE NULLS NOT DISTINCT
    (organization_id, actor_user_id, credential_kind, credential_id, idempotency_key),
  CONSTRAINT workflow_creation_keys_workflow FOREIGN KEY (organization_id, workflow_id)
    REFERENCES workflow_definitions (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_creation_keys_credential CHECK (
    (credential_kind = 'session' AND credential_id IS NULL)
    OR (credential_kind IN ('api_key', 'oauth') AND credential_id IS NOT NULL)
  ),
  -- The house rule for idempotency keys: 1 to 255 printable ASCII characters.
  CONSTRAINT workflow_creation_keys_key_format
    CHECK (idempotency_key COLLATE "C" ~ '^[!-~]{1,255}$'),
  -- A SHA-256 digest of the canonical input.
  CONSTRAINT workflow_creation_keys_fingerprint_length
    CHECK (octet_length(request_fingerprint) = 32)
);
