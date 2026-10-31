Schema-break upgrade: Build the new application first, then stop every old process that
can read or write authentication data, including separately managed web, all and worker
roles. Apply the migration and start only the upgraded code before issuing scoped keys.
Old binaries ignore scope and must never overlap with usable read or bookings keys.

Migration 0048 follows 0047_event_type_durations.sql and preserves existing duration choices,
event configuration, bookings and timestamps.

The migration aborts atomically if any non-null metadata is malformed JSON or is not an
object. Its error contains a safe count only; repair those rows under operator review
without changing key hashes or organization bindings, then retry. Existing object metadata
is preserved except that the newly reserved scope property becomes full for every old key.

Rollback requires stopping writers and safely revoking/deleting every non-full key under
a reviewed operator procedure, then following the supported backup/restore process where
needed. Never relabel restricted keys full or remove the protection to run an old binary.
