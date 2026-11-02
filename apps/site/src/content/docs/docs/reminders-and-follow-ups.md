---
title: Reminders and follow-ups
description: Choose when booking emails are sent, who receives them and an optional follow-up note.
---

Reminders are booking emails sent before the scheduled start. Follow-ups are emails sent
after the scheduled end. Configure them in **Event types** in your personal or team space.
Create or edit an event type, open **Reminders and follow-ups**, make your changes and save the event type.
You can edit your own personal event types; team event types require a team owner or admin.

The default is **one reminder 24 hours before the meeting, sent to the invitee, guests and
hosts**, with **no follow-ups**. Opening an event type and saving unrelated changes keeps
its notification settings unchanged.

## Choose the time and recipients

Add, remove or edit reminders before the scheduled start and follow-ups after the scheduled
end. Use the reminder presets of **24 hours, 2 hours or 30 minutes before**, and the
follow-up presets of **1 hour or 1 day after**, or enter a custom offset in whole minutes.

| Setting | Allowed values |
|---|---|
| Reminders | Up to 5, each 5 minutes to 30 days before the start. |
| Follow-ups | Up to 3, each 5 minutes to 30 days after the end. |
| Recipients | Select one or more of invitee, guests and hosts for every message. |

An empty list turns off that category. Each time can appear only once within its category;
select all the recipients you want on that one message. A day means 24 elapsed hours, so a
24-hour offset can appear at a different local clock time across daylight saving changes.
Changing a display time zone does not change the send time.

The **invitee** is the person who booked. **Guests** are the extra people saved on that
booking. **Hosts** are the people actually assigned to the booking, including the selected
host for round robin. A selected class with no eligible people receives nothing. Messages
are sent separately; someone who is both a host and invitee can receive two copies.

If a setting is refused, the editor identifies the affected rule and field. Correct it and
save again. Saving settings never sends an email immediately.

## Which bookings change

Changes apply only to **new bookings made after the save**. Existing bookings keep the
settings captured when they were created. Rescheduling keeps those original settings and
calculates their send times from the replacement meeting's start and end.

A reminder is skipped unless its send time is **more than one hour after booking or
rescheduling**. A reminder whose send time is in the past or too close is skipped and
never sent late to catch up. The comparison is strict: exactly one hour is not enough.
For example, a 24-hour reminder is skipped when a booking is made exactly 25 hours before
the start; booking more than 25 hours before allows it.

## What follow-ups mean

Follow-ups are timed from the **scheduled end**, regardless of attendance. Their built-in
text says that the scheduled meeting time has ended; it does not say that anyone attended,
accepted an invitation or completed the meeting. Follow-ups do not contain a meeting link
or calendar attachment. They can still be sent if automatic conference preparation failed.

**Declining in Google Calendar, Outlook or another calendar does not cancel the Hourmere
booking or stop its messages.** Cancel explicitly in Hourmere before the meeting starts.
Cancellation and rescheduling stop being available at the start; there is currently no
invitee action to stop follow-ups after that point. Consider this limit before enabling
follow-ups, and explain the planned messages to your invitees.

## Add an optional host note

Each follow-up can include a plain-text host note, limited to **2000 UTF-16 code units**
after normalization: most letters use one unit, while many emoji use two. The editor shows
a character-unit counter. Line breaks are allowed; tabs and other control characters are refused. Windows line endings are
normalized, and invisible bidirectional formatting controls are removed before validation.

The note appears only in the email body. HTML is escaped, text is not turned into a link,
and placeholders such as `{inviteeName}` are sent literally. Reminders have no host note.

Your instance operator can disable host notes with `FOLLOW_UP_HOST_NOTES_ENABLED=false`.
The editor then hides the note input and explains the restriction; built-in follow-ups
remain available. Previously saved notes
are retained but omitted from emails while notes are disabled. To edit notification
settings that contain saved notes while the switch is off, **explicitly remove those notes
before saving**. Saving unrelated event-type changes does not remove them. If the operator
enables notes again, notes retained in unsent booking snapshots can appear in later emails;
changing the switch does not resend earlier messages.

## Delivery limits

Configured emails share the instance's existing booking-mail limits. By default, an invitee
or guest address can receive up to **5 messages per rolling hour** and **20 per rolling
24 hours** across bookings and teams. The instance limit defaults to **100 messages per
rolling hour**; host and sign-in mail can continue until **120 total per rolling hour**.
The shared instance budget also counts sign-in sends and team invitation attempt
reservations. Operators may configure different limits. Hosts bypass the invitee/guest
recipient windows, but still count toward
the instance limit. Each message to each role counts separately. Setting the instance cap
to `0` disables only that cap; recipient limits still apply.

When a mail limit prevents a message, it is skipped permanently for that recipient and is
never caught up after capacity returns. Adding rules does not reserve mail capacity or
guarantee inbox delivery. Eligible messages can be delayed by worker or delivery problems:
custom messages have at most **13 attempts**, including the first. Custom reminders stop
being attempted at the start; follow-ups stop 24 elapsed hours after their planned send
time. These bounded retries do not revive reminders skipped at booking or rescheduling.
Cancelling before a send prevents pending messages, but cannot recall an email already
being submitted to the mail server.

See [notification delivery and operator controls](/docs/notifications) for retry behavior,
mail budgets and self-hosting configuration.

## Configure in the editor

For example, edit an event type and open **Reminders and follow-ups**. Change the existing
reminder's **Timing preset** to **2 hours before**, keeping Invitee, Guests and Host
selected. Choose **Add follow-up**, select **1 hour after**, and leave only Invitee
selected. If host notes are enabled, enter `Thank you for your time.` under **Host note
(optional)**. Save the event type. This schedules the two emails for future new bookings;
the reminder still needs the booking to be made more than three hours before the start.

## Configure through REST, MCP or CLI

Protected event-type reads return `notifications`. Use event-type creation or update, REST
`PUT /api/v1/event-types/{id}/notifications`, MCP `set_event_type_notifications`, or CLI
`set-event-notifications` to replace the complete settings. Configuration writes require
a **Full account access** (`full`) API key and the same owner or team-admin permissions.

Both `reminders` and `followUps` are required in a replacement; empty arrays disable them.
Omitting settings on creation uses the default; omitting them on an update preserves the
saved value. Send stable rule IDs through edits and retries. For example:

### REST

Replace `<event-type-id>` with an ID from `GET /api/v1/event-types`. With
`HOURMERE_URL` set to your instance origin and `HOURMERE_API_KEY` set privately, send:

```sh
curl --fail-with-body -X PUT "$HOURMERE_URL/api/v1/event-types/<event-type-id>/notifications" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" -H 'Content-Type: application/json' \
  -d '{"notifications":{"reminders":[{"id":"before-two-hours","offsetMinutes":120,"recipients":{"invitee":true,"guests":true,"host":true}}],"followUps":[{"id":"after-one-hour","offsetMinutes":60,"recipients":{"invitee":true,"guests":false,"host":false},"hostNote":"Thank you for your time."}]}}'
```

### MCP

Call `set_event_type_notifications` with these arguments, using an ID from
`list_event_types`. MCP OAuth may also configure settings within its authorized organization:

```json
{
  "id": "<event-type-id>",
  "notifications": {
    "reminders": [
      {
        "id": "before-two-hours",
        "offsetMinutes": 120,
        "recipients": { "invitee": true, "guests": true, "host": true }
      }
    ],
    "followUps": [
      {
        "id": "after-one-hour",
        "offsetMinutes": 60,
        "recipients": { "invitee": true, "guests": false, "host": false },
        "hostNote": "Thank you for your time."
      }
    ]
  }
}
```

### CLI

From a source checkout with `HOURMERE_URL` and `HOURMERE_API_KEY` configured privately,
pass the same MCP arguments on stdin. Notification settings use JSON, with no timing or
note command-line flags:

```sh
npm run --silent cli -- set-event-notifications --input - <<'JSON'
{
  "id": "<event-type-id>",
  "notifications": {
    "reminders": [
      {
        "id": "before-two-hours",
        "offsetMinutes": 120,
        "recipients": { "invitee": true, "guests": true, "host": true }
      }
    ],
    "followUps": [
      {
        "id": "after-one-hour",
        "offsetMinutes": 60,
        "recipients": { "invitee": true, "guests": false, "host": false },
        "hostNote": "Thank you for your time."
      }
    ]
  }
}
JSON
```

MCP and CLI take `id` beside `notifications`; REST puts the event-type ID in the URL.
See [REST](/docs/rest), [MCP](/docs/mcp), [CLI](/docs/cli) and the
[notification contract](/docs/notifications#configure-reminders-and-follow-ups) for details.

## Known limitations

- Delivery is email only. SMS, marketing campaigns and a general workflow engine are not
  available.
- Settings apply to future new bookings. There is no bulk rewrite of existing booking
  snapshots, and rescheduling retains the original settings.
- Follow-ups use scheduled time, with no attendance or no-show detection. Calendar declines
  are not processed as cancellations. Invitees cannot stop follow-ups after the start.
- Notes are plain body text only. Custom subjects, HTML templates and interpreted
  placeholders are not available. Operators can disable host notes while retaining them
  in storage.
- Each enabled recipient class needs eligible people. Hosts must still be verified current
  members; delivery also requires a usable verified organizer, even for invitee-only mail.
- Automatic meeting-link readiness can hold reminders until the current booking revision
  is ready. Reminders expire at the start; neutral follow-ups are independent of readiness.
- Mail limits permanently suppress an affected recipient's message, and delivery retries
  are bounded. No public delivery-history or force-send interface is available.
- Mail server acceptance does not prove inbox delivery. SMTP acceptance followed by a
  database commit failure can produce a duplicate, and cancellation after the final send
  check cannot recall an email being submitted.
