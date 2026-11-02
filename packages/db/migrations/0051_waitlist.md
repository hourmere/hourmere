# Waitlist storage rollout

Migration 0051 adds opt-in waitlist storage and transactional availability signals.
Existing event types remain disabled. It does not import booking contacts, backfill
mail accounting, change historical data, enqueue work or send email. The populated
upgrade test starts at 0049, then applies the published 0050 success-redirect
migration before 0051. It verifies preservation across both steps, including the
0050 columns, and compares the result with a fresh installation containing every
migration through 0051. Reapplying that complete chain must perform no writes.

Availability triggers append independent `waitlist_scan_signals` rows. They never
update shared work rows, deduplicate an event key or acquire event foreign-key
locks, so unrelated bookings sharing hosts do not wait on waitlist work. Signals
commit or roll back with their availability mutation. The scanner consumes at most
1,000 committed signals per event snapshot by their exact IDs, then advances its
`bigint` work generation. Signal UUID order is not a commit watermark: an older ID
that commits later remains pending. A committed signal visible at publication
validation discards the computed page; signals that commit later remain pending
for the next scan. Scan checkpoints retain exact `bigint` values beyond the 32-bit
integer and JavaScript safe-integer boundaries.

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
