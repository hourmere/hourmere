# Group slot and seat storage

Schema-break upgrade: Stop every old web, all-role, worker and other booking reader or
writer before applying migration 0059. Restart all roles on the complete matching release;
do not mix old and new processes. The nullable `booking_hosts.booking_id`, alternate slot
parent and surrogate primary key are unsafe for old joins even if no group is configured.
Use the supported backup/restore procedure for rollback, rather than running old binaries
against this schema.

This migration supplies first-class slot and independent seat storage, database-owned
capacity, normalized mailbox uniqueness, unchanged host overlap exclusion, immutable
snapshots, deferred count/booker/surviving-host checks and scoped operation retry receipts.
Existing event types default to individual mode. Existing bookings, guests, token hashes,
replay scopes, timestamps, reschedule chains and host occupancy values remain intact;
each legacy host row receives only a new surrogate UUID and a null slot parent.

A slot starts empty only inside the first-seat transaction. It cannot commit open without
at least one confirmed seat and its surviving pinned host occupancy. A seat's required-host
snapshot remains after host deletion; a deleted host prevents new admission but does not
prevent retained team seats from being cancelled. Cancelling the last seat retires that
generation. An explicit host-cancelled generation is terminal and preserves its exact-event
interval tombstone. Individual confirmed-seat physical deletion is forbidden; cancel it
first. Physical event deletion detaches nullable event associations and preserves slot,
seat and immutable event identity history. Organization deletion cascades owned data.

Group configuration is not publicly exposed by this storage task. Ordinary booking writes
to group event types are rejected unless they supply a valid seat binding. Do not enable
group booking until the shared admission/cancel/reschedule services, safe projections,
capacity-aware availability and every REST/MCP/CLI path are complete. Existing joins and
workers still require the service-task query inventory in this PR. Slot-owned calendar and
conference resources, scheduled-mail messages, delivery receipts and dispatch are deferred to a
later integration migration; they must never be fabricated as first-invitee-owned booking
resources. Existing workers must not process group seats as standalone resources.

Seat insert/status changes serialize on the slot and alone update its counter. Deferred
checks compare the stored count to confirmed seats and verify one matching booker; direct
counter edits cannot repair or hide an invalid final state. No session setting enables a
counter bypass. Admission still needs the service's complete sorted host advisory locks,
canonical slot locks, current eligibility, buffers, daily limits and exact replay probe.
The exclusion constraint proves instant overlap, not availability policy.

Replay receipts contain only scoped authority/fingerprint digests and IDs/counts, never
raw management capabilities. Reading them requires current authority revalidation by the
future service. Waitlist wakeups append existing nonblocking scan signals; group-aware
discovery/admission remains a later task. Populated immediate-predecessor preservation,
fresh-schema equivalence, no-op rerun and generated table types are required with this
migration.
