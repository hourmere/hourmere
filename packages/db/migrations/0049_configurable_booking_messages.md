Schema-break upgrade: Stop every old web, all-role and worker process before applying this migration; restart all roles on the matching new code before enabling custom notification settings.

Migration `0049_configurable_booking_messages.sql` follows published migration
`0048_api_key_scopes.sql`. Existing scoped API keys, ordered duration choices and actual
booking start/end instants are preserved, including bookings using a non-default duration.

Existing event types receive the exact previous all-recipient 24-hour reminder policy,
including hidden, inactive and deleted types. Existing bookings retain a NULL snapshot:
this means the immutable previous default policy, not inheritance from current settings.
The migration creates no scheduled messages, jobs or follow-ups for historical bookings.
It does not infer missing mail from absent receipts or reseed delivery accounting.

Receipt identity gains a message key. Historical keys remain empty; existing outcomes,
suppression reasons, timestamps and manage-token hashes are preserved. The unique token
index and deferred booking foreign key remain intact.

Back up the database before starting, and run this upgrade during a quiet maintenance
period with every old process stopped. The migration takes ACCESS EXCLUSIVE locks on
`event_types`, `bookings` and `booking_notifications`, blocking reads and writes to each
table once its lock is acquired. The runner applies the entire migration in one transaction,
so these locks remain held until commit. Its work includes:

- Full-table scans to validate the new CHECK constraints on all three tables, including
  per-row JSON validation on `event_types`.
- Building a unique btree index on `bookings(id, organization_id)` for the composite
  scheduled-message foreign key. This index also adds ongoing storage and write overhead.
- Rebuilding the `booking_notifications` primary-key btree with the new message key.
- Taking SHARE ROW EXCLUSIVE locks on `bookings` and `auth.organization` while adding
  the new, initially empty scheduled-message table's foreign keys.

The constant-default columns do not rewrite historical rows, but validation still scans
rows and the index builds process and sort their keys. Plan for work growing with booking,
event-type and retained receipt counts, with additional sort and I/O cost for the indexes;
the receipt index can dominate on large installations. Allow downtime for the entire
migration and test its duration on a restored production-size backup before upgrading.
The automated predecessor fixture starts at migration 0048 with full, read and bookings
API keys, populated multi-duration event types and non-default booking durations. It verifies
preservation, fresh-install schema equivalence and no-op reruns, and reports its measured
migration duration; its small synthetic dataset does not predict production lock time.

The SQL retains atomic validation and index creation. Adding CHECKs as NOT VALID and
validating later within this same transaction, or creating the booking index after its
table has already been altered, would still retain the earlier ACCESS EXCLUSIVE lock
until commit. Reducing that downtime requires a separately designed, staged rollout.

New configurable bookings store snapshots and bounded per-rule schedules transactionally.
Schedules cascade with their booking/organization; the existing mail-budget ledger has
no booking foreign key and remains unaffected by booking deletion. No application
migration changes pg-boss tables or existing queue payloads.

Mixed versions are unsupported: old writers do not store snapshots or honor configurable
policies. Build binaries first, stop old processes, apply migrations through the normal
runner, then restart matching roles. After migration, rollback requires the documented
database backup/restore procedure rather than running an old binary against this schema.
