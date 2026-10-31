---

title: Collective team scheduling
description: Book every required team host together.
---

A collective event type books **every selected host** together. Team owners and admins can
choose two to eight current members with verified email addresses in the event editor.
An individual team event has one host. Personal event types keep one host, their owner.
For one-host equal rotation, see [round-robin scheduling](/docs/round-robin-scheduling). Legacy
and newly saved round-robin pools remain metadata-only until explicitly activated; ordinary
metadata saves never activate them.

## Configuration

`POST /api/v1/event-types` and `PATCH /api/v1/event-types/{id}` accept optional fields:

```json
{
  "schedulingType": "collective",
  "hosts": [{ "userId": "<member UUID>" }, { "userId": "<another member UUID>" }],
  "scheduleId": null
}
```

Creation still requires `slug`, `title` and `durationMinutes`. Omitting these new fields
preserves the existing individual creation behavior. A scheduling-mode change requires the
complete valid host list. Omitting `hosts` and `schedulingType` on a patch preserves both.
IDs are normalized before checking duplicates, including differently cased UUIDs. Invalid,
unverified and non-member hosts return `invalid_hosts`; host assignment is not an invitation.

`GET /api/v1/event-type-hosts?limit=100&after=<nextAfter>` is the owner/admin-only directory
used by the editor. It returns `{data: [{id, name}], nextAfter}` with at most 100 members per
page, excludes unverified accounts, and exposes no email addresses or private schedules.
Ordinary team members can read event configurations but cannot manage assignments.

Collective hosts each use their **current default schedule**. A non-null `scheduleId` is
refused for collective types; the administrator does not edit other people's availability.
Individual event types retain their existing host-specific schedule behavior.

## Public links, agents and availability

Team links remain `/team/{teamSlug}/{slug}`, including inside inline and popup widgets.
The public REST namespace is `/api/v1/public/teams/{teamSlug}/{slug}`. Team slugs keep their
stored case. Public metadata includes all required hosts' names/time zones, without their
user IDs, email addresses, hours or calendar details. Location details remain private until
booking, as on personal pages.

MCP `find_available_slots` / `create_booking`, and the corresponding CLI commands, accept
exactly one of `handle` (personal) or `teamSlug` (team), plus the existing `slug` and booking
arguments. Existing handle inputs are unchanged. Pass the exact-case team slug in both calls.

Availability is the intersection of the complete **start and end** interval offered by each
host. Every host's working hours, exceptions, DST, calendar busy intervals/freshness, buffers,
notice, booking window and daily cap must allow the slot. The same UTC interval must belong
to every host's candidate grid: 09:00/09:30 and 09:15/09:45 grids need not overlap. The public
20,000-candidate budget is shared across all hosts, so a collective search may require a
shorter date range than a one-host search. It is not multiplied by the host count.

New booking transactions lock the organization, then acquire advisory locks for the full
pre-read host set in sorted order. They share-lock and re-read the event configuration before
checking every host again. A concurrent host-set change is refused; no extra host lock is
appended out of order. All booking hosts, invitees, retry state, calendar targets and queued
notifications commit or roll back together. Existing overlap constraints remain the final
protection, with advisory locks also serializing buffers and daily limits.
Host eligibility then share-locks verified users before their member rows, in sorted
user-ID order. Leave, administrative removal and role changes take the organization
update lock before any member lock, so they wait for this booking transaction and apply
their policy to its committed result. See the repository's
[team lock order](https://github.com/hourmere/hourmere/blob/main/docs/data-model.md#team-membership-and-host-lock-order)
for the complete transaction phases.

## Existing meetings and changes

Changing event-type hosts affects new bookings. A reschedule retains the **original required
host set**, uses each original collective host's current default schedule and the current
active event rules, and carries the same attendees/responses. It does not swap in the newly
configured hosts. If an original host leaves the organization, loses email verification or
is deleted, moving the meeting returns `booking_hosts_unavailable`; cancellation still works.

Migration 0019 saves the original host IDs in an immutable internal snapshot because deleting
an account cascades its live host rows. Its backfill can only recover host rows still present
when migrating; identities deleted before that point cannot be reconstructed. The snapshot
is not included in public responses.

Each host receives the normal notification and, when configured, a private destination
calendar copy. All copies use the reschedule-chain root UID, as do the ICS attachments, so
retries, rescheduling and cancellation update the same meeting. Google busy-time/calendar
writes are supported; Microsoft Graph busy-time and event writes remain pending. Synthetic
provider/mail tests establish local behavior, not real inbox deliverability or production
provider acceptance.
