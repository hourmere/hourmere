---
title: After-booking redirects
description: Offer an optional Continue link after booking, with explicit privacy and embed controls.
---

An event type can offer a **Continue** link to your website after a successful booking.
Invitees first see the normal confirmation, calendar information and private manage link,
then choose whether to continue. There is no automatic navigation or countdown.
Personal and team event types use the same settings.

## Configure in the editor

1. In your personal or team space, open **Event types** and edit the event type.
2. In **After booking**, enter an absolute HTTPS target URL. Leave it empty to turn the
   continuation off. Saving shows server validation beside the affected setting.
3. Select only the parameters your destination needs. The preview uses sample values;
   it does not send a request to the target or include real booking data.
4. Read the privacy warning before enabling invitee name/email, then select either
   personal parameter only if you intend to share it.
5. Separately enable parent navigation if an embedded booking should leave the surrounding
   page. Otherwise Continue opens a new tab from an embed.
6. Save the event type. The editor sends redirect settings only when they differ from the editor
   session's baseline; editing a title alone does not resubmit an untouched redirect.

**Warning:** selected invitee names and emails become visible to the target website and its
analytics, and can appear in browser history. The personal-data permission starts off and
is separate from selecting `inviteeName` or `inviteeEmail`. Enabling it alone adds neither
value. Review the target site's privacy practices before opting in.

## URL and parameter rules

The target must be an absolute **HTTPS** URL, at most **2000 characters** before and after
normalization, with no username/password, whitespace, control characters or malformed
Unicode. Internationalized hostnames are stored in ASCII form and Unicode paths are
percent-encoded. HTTP is refused even for local development targets.

IP addresses, including alternative IPv4 spellings, `localhost`, `*.localhost` and
single-label hosts such as `intranet` are refused by default. The operator can explicitly
allow these with `SUCCESS_REDIRECT_ALLOW_IP_HOSTS=true`; the instance's own `PUBLIC_URL`
host is also allowed. Both exceptions still require HTTPS. This is a host-syntax rule,
not a DNS or destination safety check: a dotted hostname can resolve to a private address.
Hourmere never makes a server-side request to the target.

The complete parameter whitelist is:

| Parameter | Value |
|---|---|
| `eventTypeSlug` | Public event-type slug |
| `start` | Booking start as an ISO instant |
| `end` | Booking end as an ISO instant |
| `timeZone` | Invitee's IANA time zone |
| `hostName` | Selected hosts' display names |
| `inviteeName` | Invitee name; requires the separate personal-data opt-in |
| `inviteeEmail` | Invitee email; requires the separate personal-data opt-in |

The default parameter list is empty. Names must be distinct and match the whitelist
exactly. Answers, guests, phone numbers, manage/reschedule tokens and internal identifiers
are never added. Parameters are URL-encoded; for example, `Ada & Co` becomes
`inviteeName=Ada+%26+Co`. Existing query text and fragments are preserved, and selected
parameters are appended before the fragment. If the original query already has the same
name, both values remain; make sure the target understands duplicate query parameters.
Do not put secrets or unwanted personal information in the saved URL's own query.

## REST

Use a `full` API key in the intended organization. Event-type writes retain their normal
ownership and team-role checks; `read` and `bookings` keys cannot change this setting.
Protected event-type reads include `successRedirect`; public event metadata does not expose
its target or selected parameters. See the [REST quickstart](/docs/rest) for authentication.

`POST /api/v1/event-types` accepts the setting alongside the required creation fields:

```json
{
  "slug": "intro",
  "title": "Introduction",
  "durationMinutes": 30,
  "successRedirect": {
    "url": "https://www.example.com/thanks?campaign=intro#booked",
    "parameters": ["eventTypeSlug", "start", "end", "timeZone"],
    "includeInviteePersonalData": false,
    "allowEmbedParent": false
  }
}
```

`PATCH /api/v1/event-types/{id}` replaces the complete redirect object when supplied:

```json
{
  "successRedirect": {
    "url": "https://www.example.com/thanks",
    "parameters": ["eventTypeSlug", "inviteeName"],
    "includeInviteePersonalData": true,
    "allowEmbedParent": false
  }
}
```

Omitting `successRedirect` preserves the saved setting. Send `{"successRedirect":null}` to
clear it. Inside a replacement object, omitted `parameters` defaults to `[]`, and both
permissions default to `false`; always include the values you want to retain.

Invalid settings return `invalid_success_redirect`; malformed request shapes return
`invalid_request`. The additive `field` identifies `successRedirect`,
`successRedirect.url`, `successRedirect.parameters`,
`successRedirect.includeInviteePersonalData` or `successRedirect.allowEmbedParent`.
Messages name the constraint without echoing the submitted URL or personal data.
The shared scheduling service validates all configuration interfaces.

## MCP

Use `get_event_type` to read the setting. `create_event_type` and `update_event_type` accept
the same `successRedirect` object or `null` as REST. Updates take a flat object with `id`
beside `successRedirect`; omission preserves the saved value. API keys require `full`
scope and the existing event-type permissions. Errors retain the same code and `field`.
See the [MCP quickstart](/docs/mcp) for connecting a client.

## CLI

Use `event` to read the configuration and `create-event` or `update-event` to write it,
with a `full` API key. JSON input has the same MCP shape, including `id` beside the changed
fields on update. The existing commands also accept these flags:

| Flag | Value |
|---|---|
| `--success-redirect-url` | Absolute HTTPS target URL |
| `--success-redirect-parameters` | Comma-separated whitelist names; `''` sets an empty list |
| `--success-redirect-include-invitee-personal-data` | Explicit `true` or `false` |
| `--success-redirect-allow-embed-parent` | Explicit `true` or `false` |
| `--clear-success-redirect` | Switch without a value; sends `successRedirect: null` |

For example, put `{"id":"<event-type-uuid>"}` in `event-update.json`, then run:

```sh
hourmere update-event --input event-update.json \
  --success-redirect-url 'https://www.example.com/thanks' \
  --success-redirect-parameters 'eventTypeSlug,start,timeZone' \
  --success-redirect-include-invitee-personal-data false \
  --success-redirect-allow-embed-parent false
```

These flags construct a replacement object: provide its URL along with all settings you
want to keep, either through flags or JSON. Matching values can appear in both; conflicting
values are refused before a request. The clear switch cannot be combined with redirect
flags or a non-null JSON configuration. Omitting all redirect flags and the JSON field
leaves the setting untouched. URL and whitelist validation remains on the server.
Errors preserve the stable code and safe `field`, without printing arbitrary server text.
See the [CLI guide](/docs/cli) for connection and input-file handling.

## Embedded booking behavior

By default an embedded Continue link opens a new tab with `rel="noopener noreferrer"`.
`allowEmbedParent: true` separately permits the invitee's click to navigate the surrounding
page; it never authorizes automatic navigation.

The [website widget](/docs/embedding#booking-completion) starts with a restrictive iframe
sandbox. Only after an origin/source/identifier-checked readiness message confirms the saved
parent-navigation opt-in does it add `allow-top-navigation-by-user-activation` and reload
before allowing input. That sandbox token is a capability for any user-activated top
navigation in the frame, rather than a browser restriction to the configured Continue URL.
Keep host-authored content and the embedded Hourmere origin trusted.

If readiness stalls, the widget falls back after five seconds to the restrictive sandbox;
a stalled permission upgrade replaces the old browsing context first. A setting enabled
after a restrictive frame is already interactive, or an older widget without the permission
marker, keeps Continue in a new tab for that visit. Manual iframes need matching sandbox
permission to use the opt-in; the supported widget handles the handshake and is recommended.
The widget's completion message includes no redirect URL, booking details or personal data.

## Current limits and policy changes

Only initial successful public web/embed bookings receive a continuation. API/MCP/CLI
bookings, one-time booking links, management reads, rescheduling and cancellation do not.
The target comes only from saved event-type configuration; invitees cannot supply one in
the booking request. New settings affect future bookings, and an exact creation retry
retains its original destination snapshot even after the host changes configuration.

If the operator tightens the host policy or changes `PUBLIC_URL`, a saved target may become
ineligible. Booking still succeeds with normal confirmation and no continuation.
Unrelated event-type edits still work and preserve that saved setting. Explicitly submitting
it again, even unchanged, must pass the current policy; replace it with an allowed target
or clear it. Restoring a policy cannot add a continuation to a booking that originally
had none. Operators can identify the event type from the safe `success_redirect_disabled`
log, which contains no target URL or invitee data.

Hourmere validates URL syntax and selected parameters, not the destination's availability,
content, analytics or DNS. It cannot guarantee that a target stays trustworthy after saving.
The configured URL has the 2000-character limit; adding selected booking values can produce
a longer final URL, subject to the browser and destination's own limits. Redirect settings
provide no delivery tracking or proof that the invitee followed the link.
