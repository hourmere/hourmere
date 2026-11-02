-- Retain a create retry marker separately from the time-ordered UUIDv7 primary key.
-- Actor attribution is historical: deleting a session, key or OAuth grant must not
-- permit a retained link's create request to mint another capability.
ALTER TABLE one_time_booking_links
  ADD COLUMN idempotency_key text
    CONSTRAINT one_time_booking_links_idempotency_key_format
      CHECK (idempotency_key COLLATE "C" ~ '^[!-~]{1,255}$'),
  ADD COLUMN idempotency_actor_kind text
    CONSTRAINT one_time_booking_links_idempotency_actor_kind
      CHECK (idempotency_actor_kind IN ('session', 'api_key', 'oauth')),
  ADD COLUMN idempotency_actor_id uuid,
  ADD CONSTRAINT one_time_booking_links_idempotency_shape CHECK (
    (idempotency_key IS NULL AND idempotency_actor_kind IS NULL AND idempotency_actor_id IS NULL)
    OR
    (idempotency_key IS NOT NULL AND idempotency_actor_kind IS NOT NULL AND idempotency_actor_id IS NOT NULL)
  );

CREATE UNIQUE INDEX one_time_booking_links_idempotency_key
  ON one_time_booking_links
    (organization_id, creator_user_id, idempotency_actor_kind, idempotency_actor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE FUNCTION guard_one_time_booking_link_idempotency() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF ROW(NEW.idempotency_key, NEW.idempotency_actor_kind, NEW.idempotency_actor_id)
     IS DISTINCT FROM
     ROW(OLD.idempotency_key, OLD.idempotency_actor_kind, OLD.idempotency_actor_id) THEN
    RAISE EXCEPTION 'one-time booking link create retry marker is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'one_time_booking_links_idempotency_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER one_time_booking_links_idempotency_guard BEFORE UPDATE ON one_time_booking_links
  FOR EACH ROW EXECUTE FUNCTION guard_one_time_booking_link_idempotency();
