# SCIM User PATCH audit details

`audit_events_details_check` accepts either empty details for `scim_user.updated` or a
single `operations` key with an array of one to 100 lowercase `add`, `replace` or `remove`
strings in request order. Repeated verbs are valid. The journal records only those verbs,
while PUT and all other actions retain their existing details rules.

The migration preserves every journal row. Existing writers remain compatible. The runner
holds an `ACCESS EXCLUSIVE` lock on `audit_events` while it replaces the constraint and
validates the existing rows. Later redefinitions of this constraint must carry the SCIM
branch forward and use a migration number above 0125.
