# Multiple meeting lengths

One event type can offer several meeting lengths on the same booking link. For example,
invitees can choose 15, 30 or 60 minutes for an introduction, with 30 minutes selected first.
Personal, individual team, collective and activated round-robin event types support this.

## Configure meeting lengths

1. Open **Event types** in your personal or team space and create or edit an event type.
2. Under **Allowed durations**, use the 15, 30, 45, 60 or 90-minute presets, or enter a
   custom whole-minute length in **Duration to add (minutes)** and choose **Add duration**.
   Remove lengths you no longer offer; at least one must remain.
3. Choose **Default duration** from the offered lengths. Add a new length first if needed.
   Removing the current default selects the first remaining length as the new default.
4. Save the event type. Use the saved **View and share** panel to open the booking page
   or copy its link. New personal accounts can continue the first-run setup guide here.

Offer **1–12 distinct lengths**, each **1–1440 whole minutes**, inclusive. The default must
be one of those lengths. One length works as before, without an invitee duration selector.
Lengths are kept in ascending order in the editor, saved configuration and public pages.
REST, MCP and CLI writes are sorted before storage, regardless of the submitted order.
Team owners and admins use the same controls; host and team permissions still apply.

## What invitees see

Personal, team and embedded booking pages show a labelled duration selector when several
lengths are available, with the default selected. Choosing another length refreshes the
available times before the invitee selects a time. A longer meeting can have fewer slots
because the complete meeting and its buffers must fit every required host's availability.
For round robin, one eligible available host must fit the chosen interval.

If a host removes a selected length while the page is open, the page refreshes the choices
and asks the invitee to choose again, preserving their entered details, guests and answers.
Confirmation details, emails and calendar invitations use the meeting's actual start and
end times. Changing the event type later does not change an existing booking's length.

## Open a suggested time

An ordinary personal booking URL (`/{handle}/{slug}`) or team URL
(`/team/{teamSlug}/{slug}`) can include `start` and `durationMinutes` to suggest one time:

```text
https://hourmere.example.com/ada/intro-call?start=2027-06-15T14%3A30%3A00.000Z&durationMinutes=30
```

Use a UTC instant with milliseconds for `start` and an explicit currently offered
whole-minute `durationMinutes`, even when the event offers only one length. The page
freshly checks the complete interval against the current booking rules before selecting
it. The invitee reviews the current meeting details, fills in the form and deliberately
confirms the booking, or chooses **Change time**. Times use the invitee's own language
and time zone. A round-robin link suggests a team time; a host is assigned only on booking.

Opening a link makes no booking or reservation and sends no email. Links have no expiry
timer and do not hold a time: availability is checked again on confirmation. If the time
is no longer offered, the page shows the normal picker with a general availability
notice. A removed meeting length asks the invitee to choose again. An unavailable event
shows the neutral unavailable page; a failed availability check offers a retry without
claiming the time is taken.

These ordinary links can be edited and forwarded, including links to hidden event types;
hidden means unlisted, so anyone with the link may open it. They use the event currently
at the address, including its latest title and questions. If an address is later reused,
an old link can open the replacement event, so review the details before confirming.
The suggested-time parameters are ignored on embedded pages, one-time booking links and
waitlist capability pages. Existing waitlist suggestions keep their separate behavior.

## Configure through REST, MCP or CLI

Event-type configuration uses these fields:

| Field | Meaning |
|---|---|
| `durationMinutes` | Default meeting length, a whole number from 1 to 1440. |
| `allowedDurationsMinutes` | List of 1–12 distinct whole numbers from 1 to 1440, kept in ascending order; must include `durationMinutes`. |

Create with `POST /api/v1/event-types`, MCP `create_event_type`, or CLI `create-event`.
All require `slug`, `title` and `durationMinutes`; omitting `allowedDurationsMinutes`
creates the single-length list `[durationMinutes]`. For example:

```json
{
  "slug": "intro",
  "title": "Introduction",
  "durationMinutes": 30,
  "allowedDurationsMinutes": [15, 30, 60]
}
```

Update with `PATCH /api/v1/event-types/{id}`, MCP `update_event_type`, or CLI `update-event`.
MCP and CLI take a flat object with `id` beside the changed fields. Send both duration
fields in the same update to choose a new default outside the saved list:

```json
{
  "id": "<event-type-uuid>",
  "durationMinutes": 45,
  "allowedDurationsMinutes": [15, 45, 60]
}
```

For REST, put the ID in the URL and omit `id` from the JSON body. For the CLI, save the
JSON to a request file and run `hourmere create-event --input event-request.json` or
`hourmere update-event --input event-update.json`. Configuration writes require a **Full
account access** (`full`) API key; `bookings` and `read` keys cannot change event types.
MCP OAuth retains its organization and role checks. These operations use the same
validation and permissions as REST and the editor.

On update, omitting the list preserves it. For compatibility, changing only the default
on a single-length type also replaces its sole length. On a multi-length type, the new
default must already belong to the saved list unless the same update replaces the list.
Invalid configuration values return `invalid_event_type`; malformed request shapes return
`invalid_request`. Unknown fields are rejected. Read the saved configuration with
`GET /api/v1/event-types/{id}`, MCP `get_event_type`, or CLI `event`.

For slot lookup and booking creation, `durationMinutes` means the invitee's **selected**
length. Omitting it uses the default. Pass the same selection when fetching slots, paging
through results and booking. An unsupported selection returns `invalid_duration`.
The CLI also accepts `--duration-minutes` on `slots`, `book` and `reschedule`; configuration
commands use the JSON fields above. See [REST](https://hourmere.com/docs/rest), [MCP](https://hourmere.com/docs/mcp) and
[CLI](https://hourmere.com/docs/cli) for request and private-result handling.

## Rescheduling

Rescheduling without `durationMinutes` preserves the booking's original elapsed length,
even if the host has changed the default or removed that length from the event type.
Host and invitee reschedule slot queries use the same rule. The web management pages
keep that original length. REST, MCP and CLI can explicitly select a different length,
which must belong to the current allowed list; use the same length for slot lookup and
the reschedule request. The replacement booking stores its resulting start and end times.

## Current limits

- All lengths share the event type's hosts, location, booking questions, buffers, minimum
  notice, booking window and daily, weekly and monthly booking limits. There are no per-length overrides.
- A fixed slot step stays fixed for every length. With no explicit step, start times use
  the selected length as their step. Daily, weekly and monthly limits count bookings across all lengths.
- The web rescheduling flow keeps the original length; changing length during a move
  requires REST, MCP or CLI.
