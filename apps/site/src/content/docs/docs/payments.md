---
title: Paid bookings foundation
description: What the payment hold, Checkout and Stripe webhook foundation supports.
---

**Paid booking admission remains disabled.** The internal foundation can reserve a slot
and create a Stripe-hosted Checkout Session. Stripe credentials are optional server-only
startup configuration. A signed Stripe webhook receiver is available for isolated testing.
Public checkout, payment settings and automatic refunds are future work. See the
[payment design](https://github.com/hourmere/hourmere/blob/main/docs/payments.md).

## Operator note

`PAID_BOOKINGS_ENABLED` defaults to `false`. Setting it to `true` with Stripe configured
enables `POST /api/webhooks/stripe` on a self-hosted instance. Paid hold admission and
public Checkout stay disabled. Existing holds expire regardless of the receiver setting.

An unpaid reservation holds capacity for 30 elapsed minutes and requires at least that
much time before the meeting starts. It can become confirmed only
before its database deadline; expiry or cancellation releases it. The deadline is unaffected
by daylight-saving changes. The design chooses a full refund for any payment observed after
expiry or cancellation, even if the slot is still free. The receiver records a pending
refund obligation. Automatic refund execution remains future work.

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

Planned policies are a full refund on host cancellation and, by default, a full refund on
invitee cancellation. Later settings may offer an invitee cutoff or no automatic refund,
disclosed before payment. A paid booking reschedules without a second charge while retaining
its original duration and price. The design covers late-payment refunds, retry safety and
operator intervention for failed refunds; none of those provider operations are wired yet.

## Test webhooks on a self-hosted instance

Use an isolated database and your own Stripe test account. Set `PAID_BOOKINGS_ENABLED=true`,
`STRIPE_MODE=test`, `STRIPE_ACCOUNT_ID` and the matching `STRIPE_API_KEY` or `_FILE` setting.
Run the [Stripe CLI](https://docs.stripe.com/cli) from the machine running your test server.
The example assumes the server listens on port 3100.

```sh
stripe login
stripe listen --events checkout.session.completed,checkout.session.expired,payment_intent.succeeded,refund.updated,refund.failed --forward-to http://localhost:3100/api/webhooks/stripe
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
Confirmation requires a paid Checkout Session bound to the local attempt. Late completion
retains the payment reference and refund-required marker without reopening the slot.
PaymentIntent and refund snapshots are acknowledged and deduplicated. Refund execution and
reconciliation remain future work, as do receipt and Checkout attempt cleanup. The
seven-day purge of expired or cancelled holds that never confirmed clears attendee data,
the hold retry key and the request fingerprint. Ordinary booking cancellation and
rescheduling reject paid foundation rows. Price and policy settings and automatic expiry of
provider Sessions remain future work. Tax calculation, subscriptions, deposits,
partial payments, currency conversion and Stripe Connect are out of scope. Payment-aware
one-time links, waitlist conversion, shared group seats and the full paid reschedule flow
must be implemented and tested before public rollout. No payment action is exposed through
REST, MCP or CLI in this foundation; future actions must be available through all three.
