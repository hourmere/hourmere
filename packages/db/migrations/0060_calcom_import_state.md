# Cal.com import attribution and local bookings

Migration 0060 adds persistent random source namespaces, immutable source-to-target
attribution, stable question/option crosswalks and non-personal deletion tombstones.
It does not import data, enqueue jobs or alter existing business rows. Source namespaces
must be reused only for the same real source instance, including its backups.

Stop every old web/all/worker process before applying this migration and restart all
roles with the new code before importing. Older applications do not understand the
`import` booking source and cannot enforce its read-only, local-only policy. Use the
documented backup/restore procedure for rollback; do not run old code against imported
data.

The existing booking-host exclusion constraint continues to protect imported busy
intervals. Imported rows cannot hold booking manage-token hashes or use cancelled
status. Application guards reject normal management and provider/notification paths,
including existing reschedule chains. Importing creates no calendar, conference, mail,
webhook, scheduled-message or job rows.

`bookings.import_questions` snapshots historical source question and option labels for
interpreting imported answers. It is required as a JSON array on imported bookings and
is NULL on other bookings; ordinary event-type edits cannot replace this history.

Deleting an imported target, including event-type soft deletion and user/personal
organization cascades, clears its target identity, fingerprints, policy and question
crosswalk. Only the opaque integer source key, source namespace, kind, contract version
and import/deletion timestamps remain, with an optional opaque source owner ID for
separate user batches within the same namespace. A tombstone cannot be changed back into a live
mapping or deleted by normal SQL. This prevents reruns from recreating erased personal
data. Deleting the source creator clears its creator reference without retaining the
user identity; source namespaces and tombstones remain available to reject resurrection.

The migration takes ordinary table locks for its schema changes. It does not disable
booking constraints or rewrite existing tuples. Take a backup and allow a maintenance
window for these locks.
