# SSO configuration storage

Adds six empty tables for team SSO configuration: policies, providers, domain claims,
provider domains, recovery nominations and recovery owners. No existing row is rewritten,
and nothing reads or writes the new tables yet; OIDC and SAML stay hard-off. The
predecessor on main is 0073.

Provider configuration is stored only as an AES-256-GCM envelope whose authenticated data
binds organization, provider and revision. Domain claims carry a generation that later
proofs and delegations record; a lapsed generation cannot be verified again, only a new
one. Policies, providers and claims are deleted only with their organization. See
[Data model](../../../docs/data-model.md#sso-configuration-storage) for every guarantee and
[SSO](../../../docs/sso.md) for the design.

The migration tests seed realistic accounts, teams, memberships, invitations, SCIM
credentials, member-role history and routing forms at the predecessor schema, fingerprint
every preexisting table including row versions, compare fresh and upgraded schemas, and
assert a second run is a no-op. Constraint coverage drops each object the migration
creates, and source-copy mutations remove or weaken each check and trigger rule.
