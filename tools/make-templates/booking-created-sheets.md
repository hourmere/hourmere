# New Hourmere booking → Google Sheets row

Manual recipe; [read setup and verification first](README.md). Its sibling
`.recipe.json` is an offline validation manifest, not a blueprint.

1. Create a spreadsheet with a sheet named `Bookings` and row-one headers:
   `Delivery ID`, `Event ID`, `Occurred at`, `Booking ID`, `Event type ID`, `Start`,
   `End`, `Status`, `Source`. Use a Google account with access only to intended data
   where practical; authorize it using Make's Google Sheets connection dialog.
2. Add **Webhooks > Custom webhook** named `Hourmere booking created`. Use the
   header, pass-through, verification and rejection settings in the README. For
   production use the described verifier relay unless native verification's
   security requirements have been established. Register only `booking.created`.
3. Add the signature verification step, then **JSON > Parse JSON** using the
   README structure. Filter `type` **Equal to** `booking.created` and
   `data.organizationId` **Equal to** your expected organization ID.
4. Enable sequential processing. Before writing, look up `Webhook-Id` in your
   durable successful-delivery receipt store. If present, stop successfully. If a
   previous write outcome is uncertain, search the `Delivery ID` column and
   reconcile it before continuing; do not blindly append.
5. Add **Google Sheets > Add a Row**. Select your connection, target spreadsheet
   and `Bookings` sheet; indicate that the table contains headers. Map columns:

   | Column | Value |
   | --- | --- |
   | Delivery ID | Original `Webhook-Id` header |
   | Event ID | `id` |
   | Occurred at | `occurredAt` |
   | Booking ID | `data.bookingId` |
   | Event type ID | `data.eventTypeId` (blank when null) |
   | Start | `data.start` |
   | End | `data.end` |
   | Status | `data.status` |
   | Source | `data.source` |

6. Record the delivery ID as successful only after the row is written, retaining
   receipts for at least 30 days. Preserve the returned row identifier for repair.
7. Set **Store incomplete executions = Yes**. On the Sheets module add a **Retry**
   error handler with **Automatically complete execution = No**. Review incomplete
   writes and the delivery column before manually retrying; this avoids claiming
   an uncertain append is safe to replay. Monitor failures even when Hourmere's
   webhook delivery already shows success.

The row is a historical creation snapshot, not a current booking database.
Cancellation and rescheduling will not update it. No invitee contact enrichment
or Hourmere runtime API key is needed. The receipt store and provider connections
must be configured by the operator; no third-party actions were run for this recipe.
