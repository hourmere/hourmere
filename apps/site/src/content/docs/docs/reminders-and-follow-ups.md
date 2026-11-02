---
title: Reminders and follow-ups
description: Choose when booking emails are sent, who receives them and an optional follow-up note.
---

Configure meeting emails in **Event types** in your personal or team space. Create or edit
an event type, open **Reminders and follow-ups**, make your changes and save the event type.
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
rescheduling**. A missed or too-close reminder is never sent immediately to catch up.
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

Each follow-up can include a plain-text host note. The counter shows the limit of **2000
UTF-16 character units**: most letters use one unit, while many emoji use two. Line breaks
are allowed; tabs and other control characters are refused. Windows line endings are
normalized, and invisible bidirectional formatting controls are removed before validation.

The note appears only in the email body. HTML is escaped, text is not turned into a link,
and placeholders such as `{inviteeName}` are sent literally. Reminders have no host note.

Your instance operator can disable host notes. The editor then hides the note input and
explains the restriction; built-in follow-ups remain available. Previously saved notes
are retained but omitted from emails while notes are disabled. To edit notification
settings that contain saved notes while the switch is off, **explicitly remove those notes
before saving**. Saving unrelated event-type changes does not remove them. If the operator
enables notes again, notes retained in unsent booking snapshots can appear in later emails;
changing the switch does not resend earlier messages.

## Delivery limits

Configured emails share the instance's existing booking-mail limits. By default, an invitee
or guest address can receive up to **5 messages per rolling hour** and **20 per rolling
24 hours** across bookings and teams. The instance limit defaults to **100 messages per
rolling hour**; hosts and sign-in mail share a reserve up to 120. Operators may configure
different limits. Each message to each role counts separately.

When a mail limit prevents a message, it is skipped permanently for that recipient and is
never caught up after capacity returns. Adding rules does not reserve mail capacity or
guarantee inbox delivery. Custom reminders stop being attempted at the start; follow-ups
stop 24 elapsed hours after their planned send time. Cancelling before a send prevents
pending messages, but cannot recall an email already being submitted to the mail server.

See [notification delivery and operator controls](/docs/notifications) for retry behavior,
mail budgets and self-hosting configuration.

## Configure through REST, MCP or CLI

Protected event-type reads return `notifications`. Use event-type creation or update, REST
`PUT /api/v1/event-types/{id}/notifications`, MCP `set_event_type_notifications`, or CLI
`set-event-notifications` to replace the complete settings. Configuration writes require
a **Full account access** (`full`) API key and the same owner or team-admin permissions.

Both `reminders` and `followUps` are required in a replacement; empty arrays disable them.
Omitting settings on creation uses the default; omitting them on an update preserves the
saved value. Send stable rule IDs through edits and retries. For example:

```json
{
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
        "id": "after-one-day",
        "offsetMinutes": 1440,
        "recipients": { "invitee": true, "guests": false, "host": false }
      }
    ]
  }
}
```

MCP and CLI take `id` beside `notifications`; REST puts the event-type ID in the URL.
See [REST](/docs/rest), [MCP](/docs/mcp), [CLI](/docs/cli) and the
[notification contract](/docs/notifications#configure-reminders-and-follow-ups) for details.
