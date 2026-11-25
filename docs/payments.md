# Paid bookings: design and foundation

Status: design plus internal holds, Stripe Checkout Session creation and a signed Stripe
webhook receiver. Paid booking admission stays off in deployed servers. Checkout UI,
price settings, automatic Session expiry, refunds and background reconciliation remain later work.
See the [operator note](https://hourmere.com/docs/payments).

## Shipped foundation boundary

Internal creation supports personal, individual event types with one host only. It rejects
team, collective, round-robin and group events, guests, waitlist conversion and automatic
conference or phone locations. The location rule applies to the invitee's chosen location
option, or the default when the choice is omitted; a hold stores that option's snapshot and
resolved location exactly as a confirmed booking would. `PAID_BOOKINGS_ENABLED` defaults
to false. The deployed server leaves paid hold admission disabled even when the variable
is true and Stripe configuration is present. Internal tests opt in through the service
context. The internal hold service can snapshot a trusted price and create a hosted Session
after committing the hold. There is no public Checkout UI, route, MCP tool or CLI command.

`pending_payment` can transition to `confirmed`, `expired` or `cancelled`. The immutable
`payment_hold_expires_at` deadline and host exclusion protect capacity. Confirmation records
a unique `payment_reference` and an immutable `payment_confirmed_at` marker; late success records `payment_refund_required=true` without
reoccupying the slot. The Stripe receiver invokes the booking notifier at most once. Ordinary
booking cancel/reschedule paths reject paid rows because refund-aware lifecycle handling
has not shipped. Internal confirmation, cancellation and expiry continue draining old holds
when new admission is disabled.

## Payment integration and ownership

Use a Stripe-hosted Checkout page with a Checkout Session in one-time payment mode.
A Session is the server-side checkout object; Payment Element is an embeddable UI, and
can itself use the Sessions API. They are not mutually exclusive APIs. Hosted Checkout
reduces the payment form, validation and authentication code that Hourmere and self-hosters
must maintain. Payment Element provides finer visual control but adds client integration
and deployment obligations without a current product need. See Stripe's
[Payment Element comparison](https://docs.stripe.com/payments/payment-element) and
[Checkout overview](https://docs.stripe.com/payments/checkout/how-checkout-works).

Both Checkout and correctly integrated Elements can qualify for SAQ A; SAQ A is not
exclusive to Checkout. Recommend hosted Checkout to keep card entry entirely on Stripe's
page and minimize the self-hosted payment surface. Operators still have their own PCI
attestation duties; the integration does not certify an instance. Never proxy card inputs
through Hourmere. See Stripe's [PCI guidance](https://stripe.com/guides/pci-compliance)
and [integration security guide](https://docs.stripe.com/security/guide).

Each instance uses its operator's own Stripe account. No company account, platform fee,
Hourmere-hosted relay, cloud entitlement or license check is involved. All organizations
on that instance settle to that one operator account; operators needing separate merchants
must use separate instances for this version. Per-organization Stripe Connect accounts,
transfers and onboarding are out of scope: those introduce a different merchant and
liability model, not merely another key field.

The server accepts `STRIPE_API_KEY` and `STRIPE_WEBHOOK_SIGNING_SECRET` through environment
injection or their respective `_FILE` settings pointing to mounted read-only secret files.
Choose one source per secret. Startup rejects conflicting sources, missing secrets in a
partial configuration and an API credential prefix that disagrees with the selected mode.
Set `STRIPE_ACCOUNT_ID` to the single operator account. `STRIPE_MODE` defaults to `test`
outside production and requires an explicit `test` or `live` value in production whenever
Stripe is configured. The adapter verifies the key's own Stripe account before operating
on Sessions. A restricted key needs account read and Checkout Sessions write access,
including Session reads. The receiver uses the signing secret for the configured account's
direct snapshot destination. Credentials stay in server memory. Rotate them with coordinated
web and worker restarts.
See [Stripe API keys](https://docs.stripe.com/keys).

## Prices and scope

The future event configuration has one explicit positive integer amount in currency minor
units for each offered duration, plus one ISO currency for the event. Respect zero-decimal
currencies and Stripe's supported amount bounds; never use binary floating-point money.
A missing price is a configuration error for a paid duration, not permission to book free.
An event is either free or paid; enabling payment requires prices for every offered duration.

The internal service snapshots amount and currency alongside the booked duration. Future
event settings must also snapshot the cancellation-policy version at hold creation.
Validate the eventual payment against that immutable snapshot and the configured account
and mode. Later event edits cannot change an in-progress checkout. Clients cannot submit
a price override. The future schema and public APIs for these settings are not part of
this migration. Automatic tax, tax calculation, invoices, coupons, subscriptions, deposits,
currency conversion and partial payments are out of scope. Operators must assess their
tax obligations before offering the future feature; it does not calculate tax.

## Hold → pay → confirm

Use one fixed **30-minute elapsed-time hold**. This is long enough for authentication and
matches Stripe's minimum Checkout Session expiration window (30 minutes to 24 hours);
15 minutes would always require an earlier explicit expiry. The interval is measured in
UTC instants, so DST does not lengthen or shorten it. See the
[`expires_at` parameter](https://docs.stripe.com/api/checkout/sessions/create#create_checkout_session-expires_at).

Paid admission requires the full hold window before the scheduled start, even when an
event permits shorter notice for free bookings. The stored deadline cannot exceed the
meeting start, so payment confirmation cannot create a meeting that has already begun.
Future paid availability must apply this same minimum lead time before offering a slot.

The database deadline begins when the reservation is admitted. Stripe requires at least
30 minutes from its Session creation time. The adapter uses the database deadline rounded
up to a second plus 15 seconds for the provider deadline and declines to submit more than
five seconds after local hold admission. The database deadline remains authoritative for
capacity and confirmation. A later release worker must explicitly expire still-open
Sessions and handle late-payment races under the refund rule below. See Stripe's
[Session expiry operation](https://docs.stripe.com/api/checkout/sessions/expire).

1. Under the ordinary booking permission, availability, host and exclusion-constraint
   rules, reserve the slot as `pending_payment`, with immutable expiry and request identity.
   The reservation counts as busy, including buffers and booking limits, without sending
   confirmations or creating calendar events/conferences.
2. Commit the hold and priced attempt before provider I/O. The internal service records
   submission before it calls the adapter with an idempotency key derived from the retained
   attempt ID. It holds no database transaction or pool connection during provider calls.
   Stripe creates a hosted one-time payment Session limited to immediate card methods.
   Both return URLs use the instance's public origin without booking or payment data. Only
   an internal caller can get the Checkout URL, and only while the hold and Session are open.
3. A verified payment observation can confirm only while database time is strictly before
   the deadline. The transaction locks and compares the reservation state. Confirmation
   preserves the same reservation, price and hosts, and the receiver queues normal
   confirmed-booking side effects exactly once in that transaction.
4. At `now >= expires_at`, atomically transition to `expired` and release host occupancy.
   An explicit cancellation releases it as `cancelled`. Repeated expiry/cancel/confirmation
   observations cannot revive a terminal hold or queue duplicate side effects.
5. Expiry workers sweep bounded batches. Ordinary booking admission must also release due
   holds under the same locking rules before taking a slot, so a delayed cron does not
   indefinitely prevent a valid booking. Reads must not advertise an expired hold as busy.

The exclusion constraint remains the final arbiter when two invitees race. Expiration and
confirmation serialize on the same booking row. Evaluate the deadline after acquiring the
lock using current database time; transaction-start time cannot allow a waiter to confirm
an already expired hold. Disabling new admission must not make existing live holds disappear
or stop their safe expiry. The flag is a rollout safeguard available equally to self-hosters,
not a commercial gate.

### Payment succeeds after expiry or cancellation

**Always request a full refund; never revive or opportunistically confirm the slot**, even
if the slot is currently free or the Stripe event says the charge happened before expiry.
This chooses deterministic capacity and a clear deadline over guessing whether an invitee
still wants a booking. Webhook delay can therefore cause a refund of an on-time payment;
the future checkout page must explain that only Hourmere confirmation secures the booking.

The foundation persists `payment_reference` and `payment_refund_required` and returns a
stable `refund_required` outcome for late confirmation attempts; actual refund execution
and its durable leased outbox are later work. The receiver persists the unique payment
reference and refund intent before acknowledgement. Retries reuse the same intent. Future
refund execution must reuse its provider idempotency key. Expired/cancelled remains terminal even
if the refund is pending, failed or disputed. A fresh booking requires a fresh attempt and
ordinary availability checks. Never silently charge again on retry.

Confirmed paid bookings remain visible in booking lists, details, exports and activity
analytics after cancellation. Visibility uses the durable confirmation marker, not the
current status; never-confirmed terminal holds stay hidden. Refund-aware cancellation
and rescheduling are still future work.

## Idempotency and incoming events

Keep the booking request key and normalized input fingerprint. Identical retries return
the same hold/deadline or terminal outcome; changed input with a retained key is a conflict.
Hold request keys use a dedicated `payment_idempotency_key` column and organization-scoped
unique index, separate from ordinary booking keys; equal strings cannot collide.
Use distinct persisted keys for Session creation and each refund purpose, derived from opaque
random local identities, never email addresses. Retain local deduplication longer than
Stripe's key cache. Stripe may prune API v1 idempotency keys after at least 24 hours.
The internal checkout adapter uses the persisted Session ID on replay when known. A retry
of an ambiguous create reconciles via a bounded Session lookup by attempt metadata. If it
cannot establish a single match, the same hold stays unresolved until a later retry or
normal hold expiry. It never issues a second create for that attempt, even if Stripe has
pruned its key or the first request never arrived.
See [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests).

`POST /api/webhooks/stripe` verifies `Stripe-Signature` with the official SDK over the exact
raw UTF-8 body and the endpoint signing secret. The receiver accepts multiple `v1` signatures
and checks a five-minute delivery timestamp window in either direction. Keep the server clock
synchronized. Requests are limited to 64 KiB. A missing, invalid or stale signature gets the
same `400` response. An off or unconfigured receiver returns `404`.

Only a `checkout.session.completed` snapshot with `status=complete` and `payment_status=paid`
can confirm a hold. The account, mode, Checkout Session and its PaymentIntent, amount, currency,
and local attempt binding must agree. A signed, fully bound Session can restore the Session ID
if a dispatched create lost its response. `checkout.session.expired` releases a still-pending
hold once its database deadline has passed. An expiry snapshot cannot undo a confirmation.
`payment_intent.succeeded`, `refund.updated` and `refund.failed` receive event-ID receipts. A
PaymentIntent snapshot lacks the required Session binding, and refund-state reconciliation is
future work. Other event types are acknowledged without storage. Checkout uses immediate card
methods; delayed settlement methods need a separate contract.

The event ID's primary key deduplicates concurrent deliveries. The receipt, booking row
transition, and any notification jobs or refund-required flag commit together. The unique
payment reference and booking row lock protect against distinct events describing one payment.
A failed transaction returns a retryable `503`. The receiver stores no webhook bodies and
does no Stripe API I/O. Follow Stripe's
[signature, retry and ordering guidance](https://docs.stripe.com/webhooks).

## Cancellations, refunds and rescheduling

| Cause | Default | Operator options in later settings |
| --- | --- | --- |
| Host or authorized manager cancels a paid confirmed booking | Full refund | Full refund remains mandatory for this flow |
| Invitee cancels a paid confirmed booking | Full refund | Full refund always; full refund before a displayed cutoff and none after; no automatic refund |
| Hold expires or is cancelled, but payment succeeds | Full refund | No override |
| Unpaid hold is released | No charge to refund | No override |

Snapshot the chosen invitee policy and cutoff when the hold is created and display it before
payment. A cutoff compares cancellation time to the scheduled start as elapsed time; equality
is on the non-refundable side. Policy changes cannot retroactively worsen an existing booking.
Partial refunds and fee deductions are outside the first integration. Operator discretion
for exceptional refunds remains in Stripe Dashboard, and reconciliation must observe those
refunds. Refund work must be authorized by the booking's actual cancellation actor, not by
an untrusted supplied role. Host cancellation still releases capacity immediately if Stripe
is unavailable.

A refund request is not proof that funds have arrived. Track requested, pending, succeeded
and failed outcomes separately from booking status; never tell the invitee a pending refund
has completed. Insufficient balance can leave a card refund pending; processing fees may
remain with the operator. See [Stripe refund behavior](https://docs.stripe.com/refunds).

A confirmed paid booking reschedules with **no second charge**. Preserve one payment identity
on the reschedule-chain root and atomically move its booking association with the existing
cancel-and-replace transaction. Keep original duration, currency and paid amount; changed
priced duration or event type is unsupported initially. Do not treat the predecessor's
reschedule cancellation as a refundable cancellation. Failed rescheduling preserves the old
booking. Cancellation of the current successor refunds at most once across the chain.
Unpaid holds cannot be rescheduled; cancel the hold and begin a separate attempt.

## Other scheduling behavior

| Capability | Payment contract and foundation limit |
| --- | --- |
| One-time links | Future checkout must reserve the link with the hold under its existing lock, consume it only on confirmation, and release the reservation on expiry/cancel without renewing the link's own expiry. A replay cannot make two holds. Not wired by this foundation. |
| Waitlist | An active hold removes capacity but does not mark an entry booked. Confirmation does; release signals ordinary availability re-evaluation. Notification remains an offer, not a paid reservation. Payment/waitlist conversion is later work. |
| Group seats | Group booking is outside this foundation. Later capacity accounting must count confirmed seats plus active held seats, atomically, and release only the expired seat; a whole-host exclusion cannot implement shared seats. |
| Round robin | Future paid admission must pin the selected host while holding capacity and preserve that host at confirmation. Fairness updates need one explicit reservation/confirmation policy; do not reassign after payment. Unsupported modes must fail closed until covered. |
| Collective | A paid collective reservation must hold all required hosts atomically; partial host holds are not acceptable. No public paid collective flow ships here. |
| Imported bookings | Remain local-only, read-only confirmed busy records. Never invent Stripe references, collect payment, refund or enable payment mutations for imported data. |
| Reminders and emails | No confirmation, ICS, reminder, follow-up, conference or calendar writeback for a hold. Release sends no booking-cancelled mail for a meeting that was never confirmed. Webhook confirmation queues normal effects once; workers recheck confirmed state and existing delivery gates. Payment/refund notices need separate deduplication and localized text. |
| Redirects and embeds | Existing booking-success redirects are available only after confirmed payment. A Checkout return page polls protected local status; it must not leak payment IDs or tokens to an arbitrary redirect target or parent frame. |

Every later public capability must share service behavior across REST, MCP and CLI, with
additive OpenAPI fields and open response values per [API conventions](api-conventions.md).
This internal foundation adds no checkout action to any of those interfaces and adds no
admin or invitee UI strings. Later UI work requires all public locales and en/zh-CN admin
translations before rollout.

## Storage, retention and recovery

Keep only Stripe object IDs needed for reconciliation (Session, PaymentIntent, refund and
processed event IDs), account/mode binding and minimal local financial facts such as amount,
currency, policy snapshot, timestamps and safe operation status. Do not store PAN, CVC,
expiry, card brand/last-four, billing addresses, raw provider payloads or checkout client
secrets. IDs are private references, not authorization credentials: do not expose them in
public booking catalogs, analytics or ordinary logs. The foundation stores a unique
`payment_reference` for the PaymentIntent, alongside `payment_hold_expires_at` and
`payment_refund_required`. Confirmation from the receiver requires a signed, price-bound
Checkout observation. The complete payment ledger remains future work.

Migration 0124 retains one local Checkout attempt per priced hold. It stores the local ID,
hold ID, account, mode, amount, currency, provider idempotency key, submission timestamp
and optional Session ID. The hosted URL is returned from Stripe to the internal caller
and is never stored. Hold contact-data erasure preserves this dedupe record. Migration 0189
retains only the verified event ID in each receipt. Automatic purge of the Checkout attempts
and event receipts remains future work.

The later ledger retains unresolved payment/refund operations until resolution, including
a minimal tombstone if booking contact data is erased. Resolved references default to
180 days after the later of meeting end or payment/refund resolution, then are purged;
operators may explicitly configure a documented longer accounting period before launch.
Do not silently restore erased attendee details from Stripe. Keep only the minimal dedupe
marker needed by unresolved work. Booking deletion must not cascade away an outstanding
refund obligation. Stripe's own retention is governed separately by the operator's Stripe
account; deleting a local reference does not delete the provider record. Implement and test
this ledger/retention policy before enabling real checkout; it is not shipped here.

The shipped foundation also erases personal data from never-confirmed `expired` or
`cancelled` holds once their original hold deadline is at least **seven days** old.
The minute expiry worker processes at most 500 retention candidates per run, using database
time and row locks. It deletes attendee rows (including names, email, time zones and locale), clears booking
title, responses, location and its snapshot, cancellation reason, success redirect and manage
token hash, nulls the hold retry key and request fingerprint that includes the invitee name
and email in its input, and records `payment_pii_erased_at`. The audit row and payment
reference/refund obligation remain. Confirmed-then-cancelled bookings are excluded by the
durable confirmation marker. This policy applies even when hold creation is disabled;
without a running worker, cleanup resumes when the worker returns. Admission-time expiry
only releases capacity and does not run retention work. A cancelled hold's deadline is
at most 30 minutes after creation, so retention ends within seven days and 30 minutes of
cancellation, subject to worker availability and bounded backlog processing.

The foundation expiry sweep is local-only and atomic. The later payment reconciler claims
bounded work using durable leases, commits before provider I/O, then compares the lease and
current state when applying results. Use finite request deadlines and bounded retry backoff;
retry an ambiguous operation with its original identity. Reconcile Session creation gaps,
missed/late webhooks, expired Sessions, paid-but-unconfirmed attempts and pending/failed
refunds. Queue lost work again from durable state. After an attempt budget is exhausted,
retain the obligation and raise an operator-visible safe error; manual reconciliation may
resume the same operation, never a new charge. Monitor oldest overdue hold, oldest unpaid
operation, refund backlog and terminal failures without contact or credential logging.

## Self-hoster testing and rollout

The real-Postgres hold, Session and webhook tests use a fake provider, stubbed HTTP and a
throwaway database. They require no Stripe account or real credentials. Leave Stripe settings
empty and `PAID_BOOKINGS_ENABLED=false` on deployed instances at this stage. Existing holds
continue to expire regardless of the receiver setting.

To exercise delivery on an isolated test instance, set `PAID_BOOKINGS_ENABLED=true`,
`STRIPE_MODE=test`, `STRIPE_ACCOUNT_ID` to your test account and use the matching
`STRIPE_API_KEY` and `STRIPE_WEBHOOK_SIGNING_SECRET` or their `_FILE` counterparts. Use an
isolated database, synthetic attendees and Stripe's published
[test payment methods](https://docs.stripe.com/testing), never real card details or copied
card numbers in repository fixtures. Confirm that no test object is accepted in live mode.

Install the [Stripe CLI](https://docs.stripe.com/cli), authenticate to the operator's test
account, and forward the selected snapshot events to the local server. The example uses
port 3100. Replace the port if your test server listens elsewhere.

```sh
stripe login
stripe listen --events checkout.session.completed,checkout.session.expired,payment_intent.succeeded,refund.updated,refund.failed --forward-to http://localhost:3100/api/webhooks/stripe
```

The CLI prints a listener signing secret. Configure it privately, then start or restart the
test receiver. Use the Dashboard destination's own secret when sending from a Dashboard
destination. To rotate a Dashboard signing secret, select delayed expiration for the old
secret, deploy the new secret during the overlap, then expire the old secret after every
receiver has restarted. During the overlap Stripe includes a `v1` signature for each active
secret. Keep the destination scoped to direct account events. See [Stripe webhook setup and rotation](https://docs.stripe.com/webhooks).

CLI-triggered fixtures check delivery and signatures. End-to-end confirmation additionally
requires a matching Checkout attempt created through the internal service. There is no public
flow for creating one. Cover duplicate/out-of-order delivery, wrong signature, wrong mode,
wrong amount, worker outage, exact deadline, cancellation races, delayed success/refund,
lost create response, reschedule replay and DST-crossing slots before production rollout.

Stop all old web and worker processes before applying the booking-state migration; mixed
versions do not understand pending-payment lifecycle or occupancy. Back up first and restart
all roles together. Keep existing hold expiry running while draining a disabled feature.
The normal backup/restore upgrade procedure applies; schema downgrade is not automatic.
