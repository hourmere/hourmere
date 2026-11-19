---
title: Paid bookings foundation
description: What the internal payment hold and Checkout foundation supports and where rollout stands.
---

**Paid booking admission remains disabled.** The internal foundation can reserve a slot
and create a Stripe-hosted Checkout Session. Stripe credentials are optional server-only
startup configuration. Public checkout, payment settings, an incoming Stripe webhook
receiver and automatic refunds are future work. See the
[payment design](https://github.com/hourmere/hourmere/blob/main/docs/payments.md).

## Operator note

`PAID_BOOKINGS_ENABLED` defaults to `false` and is reserved for a future rollout.
A deployed server leaves paid holds disabled regardless of its value. Internal tests explicitly opt in through
the service context. Existing holds expire regardless of this environment setting.
The planned rollout safeguard will be available to every self-hosted instance, with no
subscription or license requirement.

An unpaid reservation holds capacity for 30 elapsed minutes and requires at least that
much time before the meeting starts. It can become confirmed only
before its database deadline; expiry or cancellation releases it. The deadline is unaffected
by daylight-saving changes. The design chooses a full refund for any payment observed after
expiry or cancellation, even if the slot is still free. Actual payment processing and refunds
are future work, so this release must not be used to promise paid appointments.

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

## Testing and known limitations

Current automated tests use a fake payment provider, stubbed Stripe HTTP and throwaway
PostgreSQL databases. After the receiver ships, self-hosters will be able to use their own
test-mode account and the [Stripe CLI](https://docs.stripe.com/cli)
to forward events to the local receiver. Use Stripe's
[published test methods](https://docs.stripe.com/testing), synthetic attendees and matching
test-mode secrets; never put credentials or card details in source files or support reports.
The [design's test procedure](https://github.com/hourmere/hourmere/blob/main/docs/payments.md#self-hoster-testing-and-rollout)
distinguishes CLI delivery tests from real test Checkout confirmation.

Internal holds support personal individual events with one host only; guests, team and
group events, waitlist conversion, automatic conferences and phone locations are unsupported.
The foundation retains a supplied payment reference and refund-required marker, but has no
authenticated Stripe receiver or refund executor. Ordinary booking cancellation and
rescheduling reject paid foundation rows. Price and policy settings, provider expiry on
release and background reconciliation remain future work. Tax calculation, subscriptions, deposits,
partial payments, currency conversion and Stripe Connect are out of scope. Payment-aware
one-time links, waitlist conversion, shared group seats and the full paid reschedule flow
must be implemented and tested before public rollout. No payment action is exposed through
REST, MCP or CLI in this foundation; future actions must be available through all three.
