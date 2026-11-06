# Booking cancelled → Slack message

Manual recipe; [read setup and verification first](README.md). Its sibling
`.recipe.json` is an offline validation manifest, not a blueprint.

1. Choose a private operational Slack channel and create a Make Slack connection
   authorized to post there. Use a bot connection if available for the module and
   workspace policy. No Hourmere runtime API key is needed.
2. Add **Webhooks > Custom webhook**, name `Hourmere booking cancelled`. Apply the
   README's request-header, JSON pass-through and verification settings, including
   its production relay prerequisite. Register only `booking.cancelled`.
3. After signature verification add **JSON > Parse JSON**, with the README data
   structure. Filter `type` **Equal to** `booking.cancelled`,
   `data.organizationId` **Equal to** the intended organization ID, and
   `data.status` **Equal to** `cancelled`.
4. Enable sequential processing. Check your durable successful-delivery receipt
   store for the original `Webhook-Id`; skip an already recorded success.
5. Add **Slack > Send a Message**, select the connection and the intended channel.
   Set the text using literal labels and mapped fields as follows:

   ```text
   Hourmere booking cancelled
   Booking: {{data.bookingId}}
   Start: {{data.start}}
   End: {{data.end}}
   Event: {{id}}
   Delivery: {{WEBHOOK_ID}}
   ```

   The braces denote mapped inputs; map `WEBHOOK_ID` from the original delivery
   header. Do not add invitee information, links, or channel-wide mentions.
6. After successful posting, store the delivery ID and returned message identifier
   for at least 30 days. A crash between posting and storing the receipt can still
   cause duplicates; reconcile by the delivery marker before re-posting.
7. Set **Store incomplete executions = Yes** and attach **Retry** to the Slack
   module with **Automatically complete execution = No**. Inspect the target
   channel for the delivery marker before manually retrying uncertain outcomes.

This announces cancellation snapshots; it does not cancel a booking. A reschedule
does not trigger it. Delayed or out-of-order delivery can announce an older event,
so the text uses the immutable booking ID and times. The receipt store and provider
connections are operator configuration, not provisioned by this offline recipe.
