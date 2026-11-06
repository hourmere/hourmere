# Paid bookings: design and foundation

Status: design plus internal foundation, checked against Stripe's official documentation
on 2026-11-06. This change does **not** enable taking payments. Checkout UI, price settings,
Stripe credentials, the Stripe adapter, incoming webhooks and payment reconciliation are
later work. The foundation has a disabled-by-default feature flag and a fake provider;
it makes no Stripe network calls. See the [operator note](https://hourmere.com/docs/payments).

## Shipped foundation boundary

Internal creation supports personal, individual event types with one host only. It rejects
team, collective, round-robin and group events, guests, waitlist conversion and automatic
conference or phone locations. One-time-link checkout is not exposed. The server reads
`PAID_BOOKINGS_ENABLED` (default false); a future trusted adapter must pass that setting to
`createPaymentHold`. No public route or payment provider is configured by enabling it.

`pending_payment` can transition to `confirmed`, `expired` or `cancelled`. The immutable
`payment_hold_expires_at` deadline and host exclusion protect capacity. Confirmation records
a unique `payment_reference`; late success records `payment_refund_required=true` without
reoccupying the slot. Confirmation invokes the injected notifier at most once; the complete
checkout confirmation delivery contract below still needs the later adapter. Ordinary
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

Future configuration accepts a server-only API credential and separate webhook signing
secret through environment injection or a mounted read-only secret file. Prefer a restricted
API key with only the operations the adapter needs. The file and environment forms are
mutually exclusive; conflicting settings fail startup. Never store plaintext credentials
in the database, frontend bundle, settings response, logs or checked-in files. No key
loader is shipped by this foundation. Bind configuration to one Stripe account and test/live
mode, reject mismatches, and require an explicit production-mode selection. Rotate secrets
using coordinated web/worker restarts; retain the old webhook signing secret only for the
bounded Stripe rotation overlap. See [Stripe API keys](https://docs.stripe.com/keys).

## Prices and scope

The future event configuration has one explicit positive integer amount in currency minor
units for each offered duration, plus one ISO currency for the event. Respect zero-decimal
currencies and Stripe's supported amount bounds; never use binary floating-point money.
A missing price is a configuration error for a paid duration, not permission to book free.
An event is either free or paid; enabling payment requires prices for every offered duration.

Snapshot duration, amount, currency and cancellation-policy version at hold creation.
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

The database deadline begins when the reservation is admitted, not when the browser opens
Checkout. Creating the Stripe Session later means its minimum expiration may extend slightly
past that deadline. Therefore the database remains authoritative: do not extend the hold
to accommodate Stripe, explicitly expire any still-open Session at release, and apply the
late-payment refund rule below to races. The future adapter should bound Session creation
latency and abandon setup if too little time remains. Stripe also provides an explicit
[Session expiry operation](https://docs.stripe.com/api/checkout/sessions/expire).

1. Under the ordinary booking permission, availability, host and exclusion-constraint
   rules, reserve the slot as `pending_payment`, with immutable expiry and request identity.
   The reservation counts as busy, including buffers and booking limits, without sending
   confirmations or creating calendar events/conferences.
2. Commit the hold before provider I/O. The future checkout worker creates one Session with
   an idempotency key derived from the retained attempt ID. No transaction or pool connection
   remains held during network calls. The browser receives only the checkout capability it
   needs; returning to a success URL never proves payment.
3. A verified payment observation can confirm only while database time is strictly before
   the deadline. The transaction locks and compares the reservation state. Confirmation
   preserves the same reservation, price and hosts, and the later integration queues normal
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
and its durable leased outbox are later work. A future payment observation
must persist the unique payment reference and refund intent before acknowledgement. Retries
reuse the same intent and provider idempotency key. Expired/cancelled remains terminal even
if the refund is pending, failed or disputed. A fresh booking requires a fresh attempt and
ordinary availability checks. Never silently charge again on retry.

## Idempotency and incoming events

Keep the booking request key and normalized input fingerprint. Identical retries return
the same hold/deadline or terminal outcome; changed input with a retained key is a conflict.
Use distinct persisted keys for Session creation and each refund purpose, derived from opaque
random local identities, never email addresses. Retain local deduplication longer than
Stripe's key cache: Stripe may prune API v1 idempotency keys after at least 24 hours. An
ambiguous old create must reconcile the stored operation before creating anything anew.
See [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests).

The later endpoint verifies `Stripe-Signature` with the official SDK over the exact raw
request bytes, its endpoint signing secret and a nonzero timestamp tolerance. Reject invalid
signatures before parsing into trusted domain events. Keep payload limits and a synchronized
clock. Deduplicate event IDs and also enforce unique business transitions by payment ID;
different Stripe events can describe the same payment. Account, live/test mode, Session,
PaymentIntent, amount, currency and local attempt bindings must all agree. A Session-completed
event alone is insufficient if its payment is still unpaid. Initially enable only immediate
card payment methods; delayed settlement methods need a separate product contract.

Events may arrive repeatedly or out of order. Persist minimal verified event identity and
durable work before a quick successful acknowledgement; a failed durable write gets a
retryable error. Reconcile provider state for contradictory observations rather than moving
a terminal local state backwards. Do not store complete webhook bodies. Follow Stripe's
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
| Reminders and emails | No confirmation, ICS, reminder, follow-up, conference or calendar writeback for a hold. Release sends no booking-cancelled mail for a meeting that was never confirmed. Future confirmation queues normal effects once; workers recheck confirmed state and existing delivery gates. Payment/refund notices need separate deduplication and localized text. |
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
public booking catalogs, analytics or ordinary logs. The foundation stores a unique PaymentIntent-shaped `payment_reference` supplied by its
trusted internal confirmation caller (synthetic in tests), alongside
`payment_hold_expires_at` and `payment_refund_required`. It has no authenticated provider
receiver, amount/currency validation or complete payment ledger yet; never wire an untrusted
request directly to this internal function.

The later ledger retains unresolved payment/refund operations until resolution, including
a minimal tombstone if booking contact data is erased. Resolved references default to
180 days after the later of meeting end or payment/refund resolution, then are purged;
operators may explicitly configure a documented longer accounting period before launch.
Do not silently restore erased attendee details from Stripe. Keep only the minimal dedupe
marker needed by unresolved work. Booking deletion must not cascade away an outstanding
refund obligation. Stripe's own retention is governed separately by the operator's Stripe
account; deleting a local reference does not delete the provider record. Implement and test
this ledger/retention policy before enabling real checkout; it is not shipped here.

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

Today, run the real-Postgres hold tests with the fake provider and a throwaway database.
Do not configure production Stripe keys: this release has no Stripe adapter or endpoint.
`PAID_BOOKINGS_ENABLED=false` remains the default unless deliberately exercising the
foundation. Disabling it prevents new holds; existing holds continue to expire.

Once the adapter and endpoint are implemented, an operator can test with their own Stripe
sandbox/test-mode account, isolated database and synthetic attendees. Use matching test keys
and endpoint signing secret in private secret storage. Use Stripe's published
[test payment methods](https://docs.stripe.com/testing), never real card details or copied
card numbers in repository fixtures. Confirm that no test object is accepted in live mode.

Install the [Stripe CLI](https://docs.stripe.com/cli), authenticate to the operator's test
account, and forward only selected events to the implemented local endpoint:

```sh
stripe login
stripe listen --events checkout.session.completed,checkout.session.expired,payment_intent.succeeded,refund.updated,refund.failed --forward-to "$LOCAL_PAYMENT_WEBHOOK_URL"
```

`LOCAL_PAYMENT_WEBHOOK_URL` is a placeholder for the future receiver; no receiver path is
promised by this change. The CLI prints a listener signing secret: place it privately in
the local receiver configuration, not in issue reports or screenshots. It differs from
a Dashboard endpoint secret. CLI-triggered fixture events test delivery/signatures but do
not establish a real Hourmere attempt binding. Exercise actual test Checkout Sessions for
end-to-end confirmation. Cover duplicate/out-of-order delivery, wrong signature, wrong mode,
wrong amount, worker outage, exact deadline, cancellation races, delayed success/refund,
lost create response, reschedule replay and DST-crossing slots before production rollout.

Stop all old web and worker processes before applying the booking-state migration; mixed
versions do not understand pending-payment lifecycle or occupancy. Back up first and restart
all roles together. Keep existing hold expiry running while draining a disabled feature.
The normal backup/restore upgrade procedure applies; schema downgrade is not automatic.
