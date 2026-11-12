# SSO audit actions

Replaces `audit_events_details_check` with the same check plus seven branches for the
[SSO actions](../../../docs/audit-log.md#sso-actions). It follows 0080, the newest earlier
definition: every earlier branch, including 0080's webhook and Slack branches with their
`events` value rules, the check head and the default rule are unchanged from 0080, so existing
journal rows keep their rule. The SSO branches admit only each action's allow-listed keys:

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
is not recorded. Delete or correct that row and apply again.

Like 0080, the check is added `NOT VALID` and validated by `VALIDATE CONSTRAINT` in the same
file. The runner applies each file in one transaction, so the `ACCESS EXCLUSIVE` lock that
`DROP CONSTRAINT` and `ADD CONSTRAINT` take is held until commit, including while existing rows
are validated: audited writes wait for that scan, which grows with the journal.

The migrator applies a missing lower-numbered file after higher ones, so a later change to
`audit_events_details_check` must use a number above 0085; otherwise fresh and upgraded
installations would end with different checks.

`sso-audit-migration.test.ts` upgrades a populated database, shows the hand-written row case,
checks that every row is preserved, compares the schema with a fresh installation and reruns
the migrations as a no-op. `sso-audit-coverage.test.ts` drops the check through
`checkConstraintCoverage` and requires a protection assertion to fail.
`sso-audit-branches.test.ts` compares every earlier branch with 0080 byte for byte, and the
check's head and its `NOT VALID` and `VALIDATE` statements with 0080's.
`sso-audit-binding.test.ts` binds the SSO branches to `packages/db/src/sso-audit.ts`.
