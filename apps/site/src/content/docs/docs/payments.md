---
title: Paid bookings with Stripe Checkout
description: Set up test-mode checkout, add event prices and manage refunds and reconciliation.
---

Hourmere supports Stripe-hosted Checkout in test mode for eligible personal events.
Invitees see the price before leaving Hourmere. Stripe handles card entry.

## Operator note

`PAID_BOOKINGS_ENABLED` defaults to `false`. Enable it on an isolated self-hosted instance
with a complete Stripe test configuration to open paid checkout and receive signed events
at `POST /api/webhooks/stripe`. Live checkout remains unavailable pending rollout acceptance
and provider-reference cleanup. To stop taking new reservations while payments settle,
deactivate the paid event types and leave the webhook receiver enabled. Reconcile any missing
events before turning the switch off. Existing holds still expire and the worker still
processes recorded refunds for the configured account and mode. Saved paid events keep their prices.

An unpaid reservation holds capacity for 30 elapsed minutes, including across daylight
saving changes. The meeting needs at least that much lead time. Hourmere confirms only
after processing Stripe's signed event before the deadline. Return from Checkout in the
same browser tab to see the payment state. If a verified payment arrives after expiry or
cancellation, Hourmere requests a full refund and keeps the reservation released. A signed
payment that cannot be matched appears in reconciliation for operator review.

Before upgrading, back up and stop all old web and worker processes, then restart them
together. Follow the [backup and rollback procedure](/docs/self-hosting#upgrade-and-roll-back).

## Stripe account ownership

All organizations on an instance use the operator's Stripe account. Use separate
instances if you need separate merchants. Stripe-hosted Checkout keeps card entry on
Stripe's page. Operators are responsible for their own compliance obligations.
[Stripe's PCI guidance](https://stripe.com/guides/pci-compliance).

## Set up Stripe test mode on a self-hosted instance

1. Prepare an isolated database and a Stripe test account or sandbox. Set `STRIPE_MODE=test`
   and `STRIPE_ACCOUNT_ID` to that account's ID. Configure its API credential through
   `STRIPE_API_KEY` or `STRIPE_API_KEY_FILE`.
2. Install the Stripe CLI and use `stripe login` to select the same test account. Start
   forwarding snapshot events to your server. Use the port your test server listens on.
   [Stripe CLI](https://docs.stripe.com/cli).

   ```sh
   stripe login
   stripe listen --events checkout.session.completed,checkout.session.expired,payment_intent.succeeded,refund.created,refund.updated,refund.failed --forward-to http://localhost:3100/api/webhooks/stripe
   ```
3. Configure the listener signing secret through `STRIPE_WEBHOOK_SIGNING_SECRET` or
   `STRIPE_WEBHOOK_SIGNING_SECRET_FILE`. Set `PAID_BOOKINGS_ENABLED=true` and start or
   restart the web and worker roles with the same Stripe configuration. When using file
   settings in Compose, mount the files read-only in each role. A Dashboard destination
   uses its own signing secret and the **Events on your account** snapshot payload setting.
   If the server could not verify the account at startup, check the configuration and
   connectivity to Stripe, then restart the web role to verify again.
4. Sign in as the personal event owner. In **Event types**, edit an eligible event and set
   its payment currency and a price for every offered duration. Open the public booking page
   in a separate tab, select a time and verify the amount on Checkout. Use synthetic attendees
   and a published test payment method. [Stripe test payment methods](https://docs.stripe.com/testing).
5. Complete Checkout and wait for Hourmere to confirm. Open the booking from the return page,
   move it and verify the payment is retained, then cancel it and check the refund state and
   reconciliation report. The Stripe CLI shows delivery results.

CLI-triggered events exercise signature validation. Confirming a booking requires a
payment bound to the Checkout Session created for that reservation. To rotate a Dashboard
signing secret, choose delayed expiration for the old secret and restart all receivers
with the new one during the overlap. [Stripe webhook setup and rotation](https://docs.stripe.com/webhooks).

## Set prices through REST, MCP or CLI

Set `payment` when creating or updating an event type. Use one lowercase currency code
and one positive integer minor-unit price per offered duration. Pass `payment: null`
to make the event free. Omit `payment` on update to retain the saved prices. Existing
event-type role and credential-scope requirements apply.

```json
{"payment":{"currency":"usd","prices":[{"durationMinutes":30,"amountMinor":2500}]}}
```

Use the event-type create or update endpoint, MCP `create_event_type` or `update_event_type`,
or the corresponding CLI command with JSON input.

## Cancel or reschedule a paid booking

Authorized host and invitee cancellations release the slot and request a full refund.
Usual booking permissions and invitee deadlines apply. Stripe can hold a refund pending,
and the original payment method may take time to show the funds.
[Stripe refund processing](https://docs.stripe.com/refunds).

Rescheduling keeps the original duration and payment. Cancellation of the current booking
requests one refund for the original payment across all moves. REST, MCP and CLI use the
same booking management rules.

Host booking details and the invitee's private manage page show the original amount and
the current refund state. The host also gets a link to the payment in Stripe Dashboard,
which has its own account access controls. Confirmation and reschedule emails report
the amount paid. Cancellation emails include the recorded refund state.

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
and Refunds read/write access. Checkout also requires Checkout Sessions write.

## Known limitations

- Personal, individual, one-host events with manual locations support payment. Team,
  recurring, routed and group-seat bookings, guests, waitlist conversion, one-time links,
  automatic conferences and phone locations are outside the first release. Embedded pages
  open the full booking page to pay.
- Supported currencies are USD, EUR, GBP, CAD, AUD and JPY. Each price can be at most
  99,999,999 minor units. The minimum is 30 pence for GBP, 50 yen for JPY and 50 minor
  units for the other currencies. Stripe also applies its settlement minimum and the
  currency rules for your account. [Stripe currency rules](https://docs.stripe.com/currencies).
- The worker issues full refunds. Use Stripe Dashboard for exceptions and partial refunds.
  Stripe Connect, taxes, invoices, coupons, subscriptions, deposits, partial payments
  and Hourmere-managed currency conversion are outside this release.
- Expired or cancelled holds that never confirmed have attendee data and booking retry
  identity cleared after seven days. Cleanup of retained Stripe references and automatic
  expiry of still-open Checkout Sessions after local release remain future work.
