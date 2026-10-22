Notification email limits upgrade: stop every old web/all/worker process before applying
this migration, then restart all roles with the new code. Old workers can still send
without accounting for the new instance and recipient limits.

The migration briefly locks booking_notifications while adding terminal suppression
metadata. It preserves every existing receipt and seeds the new two-day accounting ledger
from retained sent receipts. Legacy/backfilled recipient hashes are unkeyed, so these rows
count only toward the instance budget; recipient windows restart on upgrade, leaving a gap
of at most 24 hours. Deleted booking receipts and already deleted attendee addresses cannot
be recovered.
No existing job is requeued or sent by this migration.
