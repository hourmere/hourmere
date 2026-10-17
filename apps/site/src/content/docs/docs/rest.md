---
title: REST quickstart
description: Use an Hourmere API key to find a slot, book it and manage the booking.
---

## Prepare a host and key

Run your own [instance](/docs/self-hosting), sign in, and use Settings, Availability and Event
types to set a profile handle, working hours and an active individual event type. For the
examples below the booking page is `/ada/intro`. Replace it with your own handle/slug.

Open **API keys** at `/app/api-keys`, create a key for the intended organization and copy it
once into your secret store. It acts as its creator in that organization. Keep API keys and
booking manage tokens out of URLs, shared transcripts and source control. Set these shell
variables privately (placeholders below are not working credentials):

```sh
export HOURMERE_URL='http://localhost:3000'
export HOURMERE_API_KEY='<your API key>'
```

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/me" \
  -H "Authorization: Bearer $HOURMERE_API_KEY"
```

Use `/api/v1/openapi.json` on your instance as the full request/response reference. Strict
request schemas reject unknown fields. Errors use `{ "error": "stable_code", "message": "…" }`.

## Find a time

Choose a future UTC range within the event type's booking window, at most 62 days.
The public slots endpoint returns UTC instants:

```sh
curl --fail-with-body --get "$HOURMERE_URL/api/v1/public/ada/intro/slots" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  --data-urlencode 'start=2026-11-02T00:00:00Z' \
  --data-urlencode 'end=2026-11-04T00:00:00Z'
```

Adjust these example dates so they remain in the future. Take the desired returned slot's
`start` unchanged. For local date/time-zone queries, the MCP `find_available_slots` tool
performs that conversion. A selected Google calendar with missing, failed or stale sync yields
`calendar_sync_unavailable`; fix or deliberately disable that calendar instead of assuming
unknown busy data is free.

## Create and manage one booking

Bookings send email to the host/invitee (and supplied guests) when workers are enabled. Use
an address you control for a test. Use a new idempotency key per intended booking and keep
the same body/key for retries:

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/public/ada/intro/bookings" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: <new random UUID>' \
  -d '{"start":"<chosen slot start>","invitee":{"name":"Test Invitee","email":"<your test address>","timeZone":"America/Los_Angeles"}}'
```

Save the returned `manageToken` privately. Only its hash is stored; it is returned once. A
same-key retry returns HTTP 200 (rather than 201) with the original booking and `manageToken: null`. Reusing the key with different
arguments fails with `idempotency_key_reused`; use a new key for a genuinely new booking.

The public booking and invitee management endpoints do not require an API key; the examples
include it for consistency with the authenticated calls above. A public create request's
idempotency key uses the shared anonymous namespace for that organization, so make it random.
For invitee management send the manage token in a header. Choose a new
available slot for rescheduling; it returns a replacement booking and a new manage token:

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/bookings/manage/reschedule" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H "X-Manage-Token: $HOURMERE_MANAGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"start":"<new slot start>"}'
```

Use the new token for subsequent operations. Cancelling with the current token:

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/bookings/manage/cancel" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H "X-Manage-Token: $HOURMERE_MANAGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Test cleanup"}'
```

An API response token stays with its booking; the token in a booking email follows the
reschedule chain. Treat both as credentials. The public management page carries email tokens
in a fragment (`/booking#token=…`); API calls use headers, never query parameters. Set `HOURMERE_MANAGE_TOKEN` privately to the
current returned token before running either management example.

List the key owner's hosted bookings with `GET /api/v1/bookings`. A key does not grant access
to arbitrary hosts' private bookings. Rate limits return `429` and `Retry-After`; slot races
return `slot_taken` or `slot_unavailable`. Recheck availability before retrying with a new key.
