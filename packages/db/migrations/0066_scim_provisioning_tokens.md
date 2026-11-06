# SCIM provisioning credentials

Adds an empty organization-scoped credential table; no existing account, membership,
booking or credential is rewritten. The number reserves space after the migrations in
concurrent pull requests through 0065. The predecessor on main is 0065.

Only SHA-256 base64url digests are stored. The current digest is required until revocation;
revocation erases both digests permanently. A single previous digest supports an explicit
bounded rotation overlap. Token names, creator/last rotator user ids and nonsecret timestamps are safe to list.
Actor foreign keys become null on account deletion while the timestamps remain.
Only owners can create or rotate; owners and admins can list and revoke.
At most ten active credentials allow staged replacement and recovery for the single
authoritative IdP. The organization lock serializes this cap. Lists use bounded UUID
cursors and include revoked credentials. Credentials
have no overall expiry in this foundation; revoke them or rotate with zero overlap to
invalidate the current secret immediately. Rotation cannot replace an active overlap.

The service locks the verified user, organization, membership and session before management
writes, following the existing team-management lock order. Rotation/revocation serialize on
the organization and token record. Authentication uses one conditional UPDATE, so last-use
tracking cannot undo revocation or revive a rotated-out digest. This does not yet authorize
any SCIM resources: resource endpoints are a later implementation.

The migration tests seed realistic preexisting account, membership, booking and credential
records through the earlier upgrade fixtures, fingerprint every preexisting table, compare
fresh schemas, and assert a second migration run is a no-op. Source-copy mutations verify
both predecessor preservation and the digest-format constraint.
