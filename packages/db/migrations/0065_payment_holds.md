# Pending-payment holds

Schema-break upgrade: Stop old web/all/worker processes before migration and restart
all roles with this revision. Old readers and writers do not understand the new booking
states or their occupancy semantics. Back up first; rollback requires the documented
backup/restore procedure, not an older binary against the new schema.

Existing bookings retain their status, timestamps and physical rows. The new timestamp, reference and hold-key columns default to null;
`payment_refund_required` defaults to false. A database trigger records `payment_confirmed_at`
on confirmation and preserves it after cancellation, keeping paid history visible. Only confirmed bookings and pending-payment holds
own active host occupancy; expiry and cancellation release it atomically through the
existing booking-host triggers. Migration 0061 supplies the preceding group-slot resource schema.

Keep `PAID_BOOKINGS_ENABLED=false`; it is reserved and has no runtime effect in this release. This revision has internal services and a fake
provider only, with no Checkout, price configuration, Stripe adapter or public payment
endpoint. New hold creation requires explicit internal opt-in. Existing holds can be
expired, cancelled or settled after admission is disabled; the minute expiry job always
runs. The sweep also erases invitee PII on unpaid expired/cancelled holds seven days
after their hold deadline, marking `payment_pii_erased_at` while retaining the audit row.
Hold retry keys have a separate organization-scoped unique index, avoiding ordinary
booking retry-key collisions. Actual refund execution and financial retention are follow-up work. Never use
this foundation to accept real money.

`payment-holds-migration.test.ts` upgrades realistic populated 0061 data, compares all
pre-existing columns and physical row identities, checks a fresh installation and a
no-op rerun, and exercises source-copy negative controls for lifecycle and occupancy.
See [the payment design](../../../docs/payments.md).
