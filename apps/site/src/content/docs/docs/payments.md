---
title: Paid bookings foundation
description: How Hourmere handles held slots, refunds and Stripe reconciliation.
---

**Paid booking admission remains disabled.** The internal foundation can reserve a slot
and create a Stripe-hosted Checkout Session. A signed Stripe webhook receiver is available
for isolated testing. Existing paid bookings can be cancelled or rescheduled, and the
worker processes retained refund obligations. Public checkout and payment settings are
future work. See the
[payment design](https://github.com/hourmere/hourmere/blob/main/docs/payments.md).

## Operator note

`PAID_BOOKINGS_ENABLED` defaults to `false`. Setting it to `true` with Stripe configured
enables `POST /api/webhooks/stripe` on a self-hosted instance. Paid hold admission and
public Checkout stay disabled. Existing holds expire regardless of the receiver setting.
The worker continues to send refunds already owed for its configured Stripe account and mode.

An unpaid reservation holds capacity for 30 elapsed minutes and requires at least that
much time before the meeting starts. It can become confirmed only
before its database deadline; expiry or cancellation releases it. The deadline is unaffected
by daylight-saving changes. The design chooses a full refund for any payment observed after
expiry or cancellation, even if the slot is still free. The receiver records the refund
obligation before acknowledging a bound late payment. A signed paid Session with a binding
mismatch appears in reconciliation for operator review.

Before upgrading the schema, back up and stop all old app and worker processes. Restart all
roles with the new version together; old processes do not understand the new booking states.
Use the [backup and rollback procedure](/docs/self-hosting#upgrade-and-roll-back).

## Stripe account ownership

The adapter binds an instance to its operator's own Stripe account and test or live mode.
Credentials come from environment injection or mounted read-only secret files. Leave the
optional settings empty on deployed instances while Checkout is internal. The planned flow
settles all organizations on an instance to that single operator account.

The design recommends Stripe-hosted Checkout to keep card entry on Stripe's page and reduce
the integration an operator must maintain. Both Checkout and correctly integrated Payment
Element can qualify for SAQ A; operators still have their own compliance responsibilities.
See [Stripe's PCI guidance](https://stripe.com/guides/pci-compliance).

## Cancel or reschedule a paid booking

Authorized host and invitee cancellations release the slot and request a full refund.
Usual booking permission and invitee deadlines apply. Stripe can hold the refund as pending.
A pending refund may take time to reach the original payment method.
[Stripe refund processing](https://docs.stripe.com/refunds).

Rescheduling keeps the original duration and payment, with no new charge or refund.
Cancellation of the current booking requests one refund for the original payment across
all moves. The existing booking management actions in REST, MCP and CLI use these rules.

## Reconcile Stripe and recover failed refunds

From the checkout or server container, run the following with the instance database and
Stripe configuration. The command works with the webhook switch off.

```sh
node apps/server/src/payment-reconciliation-cli.ts --limit 20
node apps/server/src/payment-reconciliation-cli.ts --limit 20 --after "$CURSOR"
```

Use the previous page's `nextCursor` for `CURSOR`. The default batch is 20 records and
the maximum is 50. The read-only report compares local holds, payments and refund obligations
with Stripe Sessions, PaymentIntents and refunds. It reports binding failures, missing and
stale data, late payments, Dashboard refunds and incomplete provider scans. It includes
private identifiers for the operator's Stripe Dashboard. Keep the output private.

1. Open the payment in the correct Stripe account and mode. Check for an existing refund
   or dispute before taking action. Stripe can leave a card refund pending while the account
   has insufficient balance.
2. If a webhook was missed, check the payment binding and redeliver the original Stripe event.
   For a binding mismatch, validate the Session and PaymentIntent in Stripe before resolving it
   through the Dashboard.
3. For a failed refund, inspect the current Stripe state and any amount still owed.
   Follow Stripe's recovery guidance, record any reimbursement and run reconciliation again.
   Preserve the original obligation and retry history. Dashboard refunds appear as external
   refunds. [Stripe failed-refund guidance](https://docs.stripe.com/refunds#failed-refunds).

The worker retries transient errors at most six times in total, stopping 23 hours after the
first attempt. Permanent failures and exhausted attempts stay available in the reconciliation
report. A restricted key needs Account, Checkout Sessions and PaymentIntents read access
and Refunds read/write access. Internal Session creation also requires Checkout Sessions write.

## Test webhooks on a self-hosted instance

Use an isolated database and your own Stripe test account. Set `PAID_BOOKINGS_ENABLED=true`,
`STRIPE_MODE=test`, `STRIPE_ACCOUNT_ID` and the matching `STRIPE_API_KEY` or `_FILE` setting.
Run the [Stripe CLI](https://docs.stripe.com/cli) from the machine running your test server.
The example assumes the server listens on port 3100.

```sh
stripe login
stripe listen --events checkout.session.completed,checkout.session.expired,payment_intent.succeeded,refund.created,refund.updated,refund.failed --forward-to http://localhost:3100/api/webhooks/stripe
```

Put the signing secret printed by the CLI in `STRIPE_WEBHOOK_SIGNING_SECRET` or its `_FILE`
counterpart, then start or restart the receiver. Use the Dashboard destination's own secret
for deliveries from a Dashboard destination, and select **Events on your account** with
snapshot payloads. Use Stripe's [published test methods](https://docs.stripe.com/testing)
and synthetic attendees. Keep credentials and card details out of support reports and source files.

To rotate a Dashboard signing secret, choose delayed expiration for the old secret and
restart all receivers with the new secret during the overlap. Stripe sends a `v1` signature
for each active secret until the old one expires. [Stripe webhook signing and rotation](https://docs.stripe.com/webhooks).

CLI-triggered fixtures exercise delivery and signature validation. Confirmation also requires
a matching Checkout attempt created through the internal hold service. Automated tests cover
that path with a fake provider and throwaway PostgreSQL databases.

## Known limitations

Internal holds support personal individual events with one host only; guests, team and
group events, waitlist conversion, automatic conferences and phone locations are unsupported.
Confirmation requires a paid Checkout Session bound to the local attempt. The seven-day purge
for expired or cancelled holds that never confirmed clears attendee data, the hold retry key
and the request fingerprint. Cleanup of Stripe references and receipts remains future work.
The refund worker sends full refunds only. Operators handle exceptional or partial refunds
in Stripe. Price and policy settings, public Checkout, refund status in booking pages and
notifications, automatic expiry of provider Sessions and payment-aware one-time links,
waitlist conversion and shared group seats remain future work. Tax calculation,
subscriptions, deposits, partial payments, currency conversion and Stripe Connect are
outside this design.
