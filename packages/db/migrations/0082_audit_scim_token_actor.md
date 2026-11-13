# SCIM provisioning token actor

Replaces `audit_events_actor_type_check` with the same closed set of actor types plus
`scim_token`, and adds `audit_scim_token_actor_credential`, which requires credential `none`
for that actor. A SCIM resource request is attributed to the provisioning token that made
it: the actor ID is the token ID, and the credential is `none` because the actor already is
the credential. No token name, secret or digest is recorded. The first event using it is
`scim_user.created`, which falls to the existing rule that requires empty details, so the
details check is unchanged.

No existing row uses the new type, so the journal is unchanged and both constraints
validate against it. The migration is safe to apply while the previous version is still
running: that version never writes the new actor type. Apply it before starting the new
version (automatic with `AUTO_MIGRATE=true`). Replacing the check and adding the new one
briefly locks `audit_events` while existing rows are validated.

The migrator applies a missing lower-numbered file after higher ones, so a later change to
`audit_events_actor_type_check` must use a number above 0082; otherwise fresh and upgraded
installations would end with different actor types. The details check is untouched, so
later replacements of `audit_events_details_check` do not interact with this file.

`audit-scim-token-actor-migration.test.ts` upgrades a populated database, checks that every
row is preserved, compares the schema with a fresh installation and reruns the migrations as
a no-op. `audit-scim-token-actor-coverage.test.ts` drops each object through
`checkConstraintCoverage` and requires a protection assertion to fail.
