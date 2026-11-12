-- A SCIM resource request is made by a provisioning token, not by a person or an API key.
-- The journal records it with actor `scim_token` (the token ID) and credential `none`: the
-- actor already is the credential, so its ID is not repeated and no secret, digest or token
-- name is recorded. Only the actor type check is replaced; it admits the same types as
-- before plus `scim_token`, so every existing row stays valid.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_type_check CHECK (actor_type IN
  ('user','api_key','oauth_client','system','anonymous','external_api_key','external_oauth_client','external_user','scim_token'));
-- The token is the actor and the credential at once.
ALTER TABLE audit_events ADD CONSTRAINT audit_scim_token_actor_credential CHECK (
  actor_type <> 'scim_token' OR credential_type = 'none'
);
