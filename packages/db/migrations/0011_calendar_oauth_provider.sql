-- Existing attempts belong to Google; a callback must only claim its own provider's state.
ALTER TABLE calendar_oauth_states
  ADD COLUMN provider text NOT NULL DEFAULT 'google'
    CHECK (provider IN ('google', 'microsoft'));
