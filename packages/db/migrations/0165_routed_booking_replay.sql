-- A committed routed booking can be replayed by the exact original request even
-- while routing is disabled, without consulting or re-opening its receipt.
ALTER TABLE booking_routing ADD COLUMN replay_fingerprint bytea
  CONSTRAINT booking_routing_replay_fingerprint_shape
  CHECK (octet_length(replay_fingerprint) = 32);

CREATE UNIQUE INDEX booking_routing_replay_fingerprint
  ON booking_routing (replay_fingerprint) WHERE replay_fingerprint IS NOT NULL;
