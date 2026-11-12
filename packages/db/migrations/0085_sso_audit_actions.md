# SSO audit actions

Replaces `audit_events_details_check` with the same check plus seven branches for the
[SSO actions](../../../docs/audit-log.md#sso-actions). Every earlier branch, the check head and
the default rule are unchanged from 0078, so existing journal rows keep their rule. The SSO
branches admit only each action's allow-listed keys:

- `method` (`oidc` or `saml`);
- `providerId` and `correlationId`, each a lowercase UUIDv7;
- `revision`, a JSON integer from 1 to 2147483647;
- `outcome`, from the action's own list (`passed` or `failed` for a provider test; `passed`,
  `failed` or `unknown` for a domain renewal);
- `reason`, from the closed list of reason codes.

SSO actions without details fall to the existing rule that requires an empty object.

No version writes an SSO action yet, so the migration is safe to apply while the previous
version is still running, and the previous version keeps working after it. The previous check
let an SSO action name through only with empty details, and no version wrote one. A row
written by hand with an SSO action whose new branch requires keys, for example
`sso_provider.created` with `{}`, makes the migration fail with 23514
(`audit_events_details_check`). Nothing changes then: the old check stays and the migration
is not recorded. Delete or correct that row and apply again. Re-adding the check briefly locks
`audit_events` while existing rows are validated.

The migrator applies a missing lower-numbered file after higher ones, so a later change to
`audit_events_details_check` must use a number above 0085; otherwise fresh and upgraded
installations would end with different checks.

`sso-audit-migration.test.ts` upgrades a populated database, shows the hand-written row case,
checks that every row is preserved, compares the schema with a fresh installation and reruns
the migrations as a no-op. `sso-audit-coverage.test.ts` drops the check through
`checkConstraintCoverage` and requires a protection assertion to fail.
`sso-audit-branches.test.ts` compares every earlier branch with 0078 byte for byte, and
`sso-audit-binding.test.ts` binds the SSO branches to `packages/db/src/sso-audit.ts`.
