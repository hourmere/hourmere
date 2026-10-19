-- OAuth discovers its Zoom identity only after exchange, so the token-operation lease
-- belongs to the Hourmere owner. Existing grants and pending states are unchanged.
CREATE TABLE conference_token_operations (
  user_id uuid PRIMARY KEY REFERENCES auth."user"(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
