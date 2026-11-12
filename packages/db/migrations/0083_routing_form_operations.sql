-- Replay records of idempotent routing form configuration writes (docs/routing-forms.md,
-- step a3b). Storage only: routing stays hard-off, and no transport reaches these rows yet.
--
-- One row per create or publish that carried a client `requestId`. The request key is scoped
-- to the organization and the acting credential (the session's user, the API key or the
-- OAuth grant, by kind and ID), never shared across them. The actor is historical, with no
-- foreign key: deleting a key or grant must not let a retained request write again. The
-- fingerprint is a SHA-256 digest of the canonical, validated input only, so an exact retry
-- returns its stored result and changed input is refused. The result is a reference: the
-- created form, or the published version of its form.
--
-- Retention is bounded by the result itself: a row goes with its form (organization deletion)
-- or its version (later version cleanup), through cascading composite foreign keys, and at
-- most one row exists per form for creation and per version for publication. Rows therefore
-- never outnumber the forms and versions the routing quotas already bound, and need no purge
-- job of their own. A row never changes once written.
CREATE TABLE routing_form_operations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('create', 'publish')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('session', 'api_key', 'oauth')),
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  form_id uuid NOT NULL,
  version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routing_form_operations_request_key
    UNIQUE (organization_id, actor_kind, actor_id, request_id),
  -- One creation per form and one publication per version; also the cascade lookups.
  CONSTRAINT routing_form_operations_result_key
    UNIQUE NULLS NOT DISTINCT (organization_id, form_id, version_id),
  CONSTRAINT routing_form_operations_result_shape
    CHECK ((operation = 'publish') = (version_id IS NOT NULL)),
  CONSTRAINT routing_form_operations_form_fk FOREIGN KEY (organization_id, form_id)
    REFERENCES routing_forms (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT routing_form_operations_version_fk FOREIGN KEY (organization_id, form_id, version_id)
    REFERENCES routing_form_versions (organization_id, form_id, id) ON DELETE CASCADE
);

CREATE FUNCTION guard_routing_form_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'routing form operation records are immutable'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'routing_form_operations_immutable';
END $$;
CREATE TRIGGER routing_form_operations_guard BEFORE UPDATE ON routing_form_operations
  FOR EACH ROW EXECUTE FUNCTION guard_routing_form_operation();
