# SSO identity storage

Adds six empty tables for SSO identities: identity links, pending attempts, mailbox proof
tokens, the replay cache, browser proofs and delegation bindings. No existing row is
rewritten, and nothing reads or writes the new tables yet; OIDC and SAML stay hard-off. The
predecessor on main is 0074.

Links are unique per provider and subject, carry a generation and are retired rather than
deleted. Attempts freeze what they were created for and are consumed once, only with every
required proof live. Only digests of mailbox tokens and replayed protocol IDs are stored.
Browser proofs and delegation bindings record the trust generation, link generation and
domain claim generation they relied on, each current when written, and are immutable.
Admission tombstones stay in the shared `scim_membership_blocks` table of 0073. See
[Data model](../../../docs/data-model.md#sso-identity-storage) for every guarantee and
[SSO](../../../docs/sso.md) for the design.

The migration tests seed realistic accounts, teams, sessions, API keys, MCP OAuth grants,
SCIM blockers and the SSO configuration of 0074 at the predecessor schema, fingerprint every
preexisting table including row versions, compare fresh and upgraded schemas, and assert a
second run is a no-op. Constraint coverage drops each object the migration creates, and
source-copy mutations remove or weaken each check and trigger rule.
