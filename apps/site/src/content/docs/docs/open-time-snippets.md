---
title: Open-time snippets for agents
description: Draft an email with current open times and direct booking links through REST, MCP or CLI.
---

Ask an agent: **“Reply to this email with three times next week.”** Hourmere can supply
current alternatives and ready-to-use plain text and HTML. The agent can put the returned
`text` or `html` in your email draft. Generating a snippet does not send the email, create a
booking or reserve any time.

## Prepare the event and access

Save an active event type with its hosts, working hours and public address configured.
Personal types require their owner; team types require a current team owner or admin in
the acting organization. Ordinary team membership or being an assigned host is insufficient.
Use `catalog` / MCP `list_event_types` to find the event type ID, or use its saved `slug`
in the current organization. Supply exactly one of `eventTypeId` and `slug`. If a slug
is ambiguous, `400 ambiguous_event_type_slug` asks you to use the ID instead.

A `read`, `bookings` or `full` API key can generate snippets, subject to those same
permissions. `read` is sufficient because this operation reads current availability and
formats reusable public links; it creates no booking, one-time capability or reservation,
and changes no configuration. MCP OAuth uses the existing `mcp:tools` grant.

The instance operator must enable `SLOT_SNIPPETS_ENABLED` (default `false`). This is the
same rollout setting as the saved-event **Copy open times** picker. Self-hosted instances
have the complete REST, MCP, CLI and browser feature, with no subscription requirement.
Deploy the public direct-slot booking pages on the same instance before enabling it.
Hidden/unlisted active events remain usable through their direct links, just as in the
picker; forwarding a snippet also forwards access to that unlisted address.

## When the feature is off

With `SLOT_SNIPPETS_ENABLED=false` (the default), a valid authenticated request sees:

| Channel | Response |
|---|---|
| REST | `POST /api/v1/open-time-snippets` returns HTTP 404 with `{"error":"slot_snippets_disabled"}`. |
| MCP | `generate_open_time_snippet` is absent from `tools/list`. A direct `tools/call` returns JSON-RPC error `{"code":-32602,"message":"Tool generate_open_time_snippet not found"}`. |
| CLI | `hourmere open-time-snippet --json` exits 1, writes `{"error":"slot_snippets_disabled"}` to stderr, and leaves stdout empty. |

The CLI maps the hidden-tool response to a client error, without `outcomeMayBeUnknown`:
this read-only call did not generate a snippet or change anything. Ask the instance
operator to enable the setting, then refresh MCP tool discovery and retry. Enabling it
makes the tool discoverable and allows all three channels to return the snippet described below,
subject to the same permissions and availability checks.

## Draft three times next week

Resolve “next week” using the sender's intended time zone and current date before calling
the tool. For example, a request made on November 6, 2026 for next week in Los Angeles
uses local midnight Monday, November 9 through Monday, November 16:

```json
{
  "slug": "intro",
  "from": "2026-11-09T00:00:00-08:00",
  "to": "2026-11-16T00:00:00-08:00",
  "count": 3,
  "displayTimeZone": "America/Los_Angeles",
  "locale": "en"
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

For MCP, call **`generate_open_time_snippet`** with the same JSON object. All three
entry points use the same service and the browser's snippet formatter. Keep the returned
notice about availability in the draft. Select `locale: "zh-CN"` for Simplified Chinese;
English, German, French, Spanish and Brazilian Portuguese are supported too.

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
