Schema-break upgrade: Stop every old web, all-role and worker process before applying this migration; restart all roles on the matching new code before enabling custom notification settings.

Existing event types receive the exact previous all-recipient 24-hour reminder policy,
including hidden, inactive and deleted types. Existing bookings retain a NULL snapshot:
this means the immutable previous default policy, not inheritance from current settings.
The migration creates no scheduled messages, jobs or follow-ups for historical bookings.
It does not infer missing mail from absent receipts or reseed delivery accounting.

Receipt identity gains a message key. Historical keys remain empty; existing outcomes,
suppression reasons, timestamps and manage-token hashes are preserved. The unique token
index and deferred booking foreign key remain intact. Rebuilding the receipt primary key
requires an exclusive table lock; allow a maintenance window proportional to retained
receipt count and test its duration on a restored production-size backup. The automated
predecessor fixture verifies preservation and reports its measured migration duration;
its small synthetic dataset does not predict production lock time.

New configurable bookings store snapshots and bounded per-rule schedules transactionally.
Schedules cascade with their booking/organization; the existing mail-budget ledger has
no booking foreign key and remains unaffected by booking deletion. No application
migration changes pg-boss tables or existing queue payloads.

Mixed versions are unsupported: old writers do not store snapshots or honor configurable
policies. Build binaries first, stop old processes, apply migrations through the normal
runner, then restart matching roles. After migration, rollback requires the documented
database backup/restore procedure rather than running an old binary against this schema.
