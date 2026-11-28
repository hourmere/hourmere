---
title: Share available times in email
description: Pick open times in the dashboard or generate an email snippet through REST, MCP or CLI.
---

Share a short list of times for one meeting. Each time has its own link to your
booking page. Paste the list into your email draft and send it from your email app.

## Pick and copy times

1. In **Event types**, open the saved event type in the personal or team space that
   owns it. Save any edits you want to share. Under **View and share**, click
   **Pick open times**.
2. Choose a **Meeting length**, **Email language** and **Display time zone**. The
   availability date uses that zone. Select one to ten times under **Available times**.
   Change the date to pick times on additional days. Changing the meeting length clears
   the selection.
3. Click **Preview email**. Choose **Copy rich text** for linked time labels in a
   rich-text composer, or **Copy plain text** to include the full URL below each time.
   If clipboard access is unavailable, select and copy the complete plain-text preview.
   Hourmere checks the selected times again before copying. If a time is marked
   **No longer offered**, use **Remove time**, select a replacement if needed, and
   preview again.
4. Paste into your draft and keep the availability notice.

Only the saved event type is used. The operator must enable `SLOT_SNIPPETS_ENABLED`
for **Pick open times** to appear to personal owners or team owners and admins. The
event must be active and round-robin events must be activated.

## What recipients see

The email lists the event title, meeting length and each proposed time with its time
zone and UTC offset. The labels stay in the email language and display zone you chose.
For a time that crosses a daylight-saving change, the label shows the offset at each
end. The booking page uses the invitee’s own language and time zone.

If the linked time is still available, the booking page opens with it selected. The
invitee fills in the usual booking form and confirms there. If someone has already
taken the time, the page says **That time is no longer available. Please pick another
one.** and shows the normal time picker. The invitation offers alternatives for one
meeting without holding any of them. Anyone with a forwarded link can open an active
unlisted event, so share those links only with the people you intend to invite.

## Prepare the event and access

To generate from a script or ask an agent to offer three times next week, save an active
event type with its hosts, working hours and public address configured. Personal types
require their owner. In the acting team, owners and admins can generate snippets.
Ordinary team membership and host assignment alone do not grant access.
Use `catalog` / MCP `list_event_types` to find the event type ID, or use its saved `slug`
in the current organization. Supply exactly one of `eventTypeId` and `slug`. If a slug
is ambiguous, `400 ambiguous_event_type_slug` asks you to use the ID instead.

A `read`, `bookings` or `full` API key can generate snippets, subject to those same
permissions. `read` is sufficient because this operation reads current availability and
formats reusable public links; it creates no booking, one-time capability or reservation,
and changes no configuration. MCP OAuth uses the existing `mcp:tools` grant.

The instance operator must enable `SLOT_SNIPPETS_ENABLED` (default `false`). Self-hosted
instances have the complete REST, MCP, CLI and browser feature, with no subscription
requirement. Deploy the public direct-slot booking pages on the same instance before
enabling it. Set `PUBLIC_URL` to the instance's public HTTPS address so the links can
be opened from email.

## When the feature is off

With `SLOT_SNIPPETS_ENABLED=false` (the default), a valid authenticated request sees:

| Channel | Response |
|---|---|
| REST | `POST /api/v1/open-time-snippets` returns HTTP 404 with `{"error":"slot_snippets_disabled"}`. |
| MCP | `generate_open_time_snippet` is absent from `tools/list`. A direct `tools/call` returns JSON-RPC error `{"code":-32602,"message":"Tool generate_open_time_snippet not found"}`. |
| CLI | `hourmere open-time-snippet --json` exits 1, writes the JSON below to stderr, and leaves stdout empty. |

```json
{
  "error": "slot_snippets_disabled"
}
```

The CLI maps the hidden-tool response to a client error, without `outcomeMayBeUnknown`:
this read-only call did not generate a snippet or change anything. Ask the instance
operator to enable the setting, then refresh MCP tool discovery and retry. A server that
predates open-time snippets returns the same unknown-tool response and is also reported
as not enabled; ask the operator to upgrade that server before enabling the setting. Enabling it
makes the tool discoverable and allows all three channels to return the snippet described below,
subject to the same permissions and availability checks.

## Draft three times next week

Resolve “next week” using the sender's intended time zone and current date before calling
the tool. In this example, the organizer’s week runs from midnight on Monday, March 8,
2027 in Los Angeles to midnight the following Monday. Daylight saving changes the UTC
offset during that week. The recipient is in Shanghai, so the email labels use Shanghai
time.

```json
{
  "slug": "intro",
  "from": "2027-03-08T00:00:00-08:00",
  "to": "2027-03-15T00:00:00-07:00",
  "count": 3,
  "displayTimeZone": "Asia/Shanghai",
  "locale": "en",
  "durationMinutes": 30
}
```

Use future dates for your actual request. Save the object as `snippet-request.json`, then
choose one entry point:

```sh
# HOURMERE_URL and HOURMERE_API_KEY are already in your private environment.
curl --fail-with-body "$HOURMERE_URL/api/v1/open-time-snippets" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @snippet-request.json

npm run --silent cli -- open-time-snippet --json --input snippet-request.json
# Standalone package, once installed:
hourmere open-time-snippet --json --input snippet-request.json
```

For MCP, call **`generate_open_time_snippet`** with the same JSON object as the tool
arguments. All three entry points use the same service and the browser's snippet
formatter. Use the returned `text` in a plain-text draft or insert `html` as formatted
content. Keep the availability notice in the draft. Select `locale: "zh-CN"` for
Simplified Chinese. English, German, French, Spanish and Brazilian Portuguese are
supported too.

## Request and response reference

`POST /api/v1/open-time-snippets` accepts the same JSON fields as the MCP tool and CLI.
Its schema is included in `/api/v1/openapi.json`. Both range boundaries are RFC 3339
instants with uppercase `T`/`Z` or an explicit UTC offset and at most three
fractional-second digits.

| Field | Meaning |
|---|---|
| `eventTypeId` or `slug` | Exactly one saved event reference in the caller's acting organization. |
| `from` | Required inclusive start instant. |
| `to` | Required exclusive end instant, after `from` and at most **31 elapsed days** later. |
| `count` | Optional integer from 1 to 10; defaults to 3. |
| `displayTimeZone` | Optional IANA zone for labels; defaults to the caller's profile zone, with UTC fallback. |
| `locale` | Optional supported snippet language; defaults to the caller's profile language, with English fallback. |
| `durationMinutes` | Optional offered meeting length; defaults to the event type's default length. |

The service chooses the earliest available starts in chronological order, up to `count`.
It can return fewer than requested. These are alternatives for **one** meeting and may
overlap or fall on the same day; there is no “one per day” ranking. The actual slot engine
applies working hours, calendar busy time, existing bookings, notice, booking window,
buffers and daily/weekly/monthly limits, including collective and activated round-robin
rules. The slot engine's existing candidate-work bound also applies; shorten a range
rejected with `range_too_long`.

The result contains `bookingUrl`, `durationMinutes`, `locale`, `displayTimeZone`,
`slots: [{start, end, label, url}]`, `text` and `html`. Instants identify each exact time;
`url` opens that time on the ordinary booking page. Both rendered forms use the same
labels and availability notice as the admin picker for the same selection. Clients must
ignore additive fields they do not know. `--json` explicitly selects the CLI's normal JSON
output; request options, including meeting length, go in the input JSON.

Date boundaries are absolute instants, independent of the display zone. At a daylight
saving transition, convert each local boundary separately: its offset may differ from
the other boundary. A local month is not necessarily 31 elapsed days. The display zone
and language change labels only; they do not change availability or force the invitee's
booking-page preferences.

## Known limitations and recovery

- No available time returns `409 no_available_slots`, not invented alternatives or a
  successful empty snippet. Widen or move the range within its bound, or report that no
  times were found. Permission, loading or availability errors do not establish that
  the host has missing configuration.
- A temporarily unavailable host calendar returns `409 calendar_sync_unavailable`.
  Retry shortly; this error does not mean there are no available times.
- Disabled-feature responses differ by channel; see [When the feature is off](#when-the-feature-is-off).
  Inactive/deleted events return `404 event_type_not_found`; unavailable public
  configuration cannot generate a usable snippet. Hidden active events are allowed.
- The response is a live availability snapshot. Repeating a request is safe and creates
  no record, but may return different times. There is no idempotency key or saved result.
- A direct link never confirms a booking by itself. If its time is already taken when
  opened, the booking page explains that it is unavailable and offers other available
  times. A race at confirmation still uses the ordinary booking conflict handling.
- Later cancellation or rescheduling may change which times are open; existing snippets
  are not edited or recalled. Generate a fresh snippet before sending a delayed draft.
- Direct links use the instance's configured `PUBLIC_URL`. There is no invitee prefill,
  one-time token, private calendar detail, email sending or hold in this operation.
