# Waitlist storage rollout

Migration 0051 adds opt-in waitlist storage and transactional availability signals.
Existing event types remain disabled. It does not import booking contacts, backfill
mail accounting, change historical data, enqueue work or send email. Migration
0050 is reserved by a separate change; the populated predecessor test starts at
0049.

Build first, then stop every old web, all-role and worker process before applying
the migration. Restart every role on the matching code before enabling waitlists.
The schema is additive, but old mutation writers do not implement waitlist cleanup
or wakeups, so mixed behavioral versions are unsafe. Use the documented backup
and restore procedure for rollback; do not assume a schema downgrade is safe.

Admission accounting has no cascading entry/event foreign keys and retains only
purpose-separated email/IP digests for two elapsed days. Exact-slot dedupe records
likewise survive deletion and retain the event UUID, recipient digest, UTC slot
bounds and safe outcome until the slot ends plus 48 elapsed hours. Contact data is
cleared immediately on removal; terminal operational rows and revoked capability
digests are removed within seven days by bounded cleanup. Key rotation retires old
waitlists before further admission or background work; no old key is retained.

This migration establishes durable candidate/outbox records only. Sending
verification and availability mail is implemented by a later task.
