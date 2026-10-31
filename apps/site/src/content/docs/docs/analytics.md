---

title: Booking activity
description: View bounded daily booking activity for your organization.
---

`/app/analytics` shows first-party booking activity in the current organization: three
totals and a daily table. Choose inclusive start/end dates (at most 90 calendar dates) and
an IANA reporting time zone. The initial view covers 30 dates ending today in the profile's
time zone, or UTC before onboarding. A day can have 23 or 25 hours across daylight saving;
a date skipped by a time-zone change has zero activity.

Personal reports belong only to the personal account owner. Team reports cover the whole
acting organization and require its current owner/admin role, including for API keys.
Ordinary team members, even hosts of some team bookings, receive `403 insufficient_role`.
The page explains that permission requirement. Membership and roles are checked from the
database in the same statement that aggregates the counts.

The authenticated REST endpoint accepts session cookies or an API key:

```http
GET /api/v1/analytics/bookings?startDate=2026-10-01&endDate=2026-10-03&timeZone=Europe%2FBerlin
Authorization: Bearer <API key from your secret manager>
```

It returns `startDate`, `endDate`, the normalized `timeZone`, `totals` and `data` (daily
counts, ordered by date, including zero days). Each totals/day object has `created`,
`rescheduled` and `cancelled`; daily objects also have `date`. No booking IDs, names,
email addresses, answers, cancellation reasons, source credentials or management tokens
are included. There is no organization-ID override or unlimited pagination.

These are **operation-date counts**, independently of when the meeting was scheduled:
- **Created:** initial booking rows, without a `rescheduled_from_id`, by `created_at`.
- **Rescheduled:** each successor booking row, by its `created_at`. A chain moved three
  times contributes three reschedules, including when the last booking is later cancelled.
- **Cancelled:** cancelled rows by `cancelled_at`, excluding any row with a successor in
  the same organization. A move's withdrawal is not an actual cancellation. Successors
  outside the chosen report dates still exclude those withdrawals.

A creation committed once and replayed with the same idempotency key still counts once.
The SQL branches use one database snapshot, so an in-flight transactional reschedule
cannot expose only its cancellation half. Temporal computes local-date UTC boundaries;
parameterized indexed range scans aggregate the stored records without reading attendee or
answer rows. Migration 0018 adds organization/creation and organization/cancellation-time
indexes; the existing predecessor index supports withdrawal exclusion.

The report reconstructs history from **currently retained booking rows**, rather than an
immutable event log. Account/organization deletion removes related data, and administrative
hard deletion can change chain-derived history. `created_at` uses PostgreSQL's stored
transaction-start timestamp; `cancelled_at` is the service's stored cancellation time.
This is not a millisecond-precise execution log. Soft-deleting an event type preserves its
existing booking activity. The report does not measure page views, unique visitors,
conversion, attendance, no-shows or meeting completion. It adds no tracking pixel, external
telemetry or analytics dependency.
