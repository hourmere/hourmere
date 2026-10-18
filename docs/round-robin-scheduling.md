# Round-robin scheduling

A team owner or admin can configure an equal-rotation pool of **one to eight** current,
verified team members. Every booking assigns exactly one available person. Individual and
collective types keep their existing behavior. Weighted routing is not supported; the
historical database `weight` field does not change equal rotation.

## Save, then explicitly activate

Create or update the event type through the editor or REST:

```json
{
  "slug": "intro",
  "title": "Team introduction",
  "durationMinutes": 30,
  "schedulingType": "round_robin",
  "hosts": [{ "userId": "<first-member-uuid>" }, { "userId": "<second-member-uuid>" }],
  "scheduleId": null
}
```

Each host uses their current default schedule. Personal organizations cannot create these
types, and a non-null custom `scheduleId` is refused. Only current verified team members
appear in the paginated editor directory. The directory does not expose private hours.
Changing `schedulingType` requires the complete `hosts` list; omitting hosts in a PATCH
otherwise preserves the pool. UUIDs are normalized before duplicate/bounds checks.

Saving a new pool does **not** activate it. The owner/admin then chooses **Activate round
robin**, or sends `POST /api/v1/event-types/{id}/round-robin/activate` with `{}`. The response
has `roundRobinActive: true`. The activation transaction rechecks current authorization,
the full host set and current verified membership. The general `isActive` setting also
has to be true for the public page to be served.

Legacy round-robin configurations and pools switched back from another mode remain
inactive until this explicit action. Ordinary Save, metadata PATCH, or toggling `isActive`
never activates a pool. Switching to a different mode disables activation. The editor
shows activation separately so an ordinary legacy metadata save cannot publish routing.

## Discovery and assignment

Use `/team/{teamSlug}/{slug}`, its embed form, or the existing team REST endpoints. MCP
`find_available_slots` / `create_booking` and CLI `slots` / `book` accept `teamSlug` instead
of `handle`; exactly one namespace is required, and team slugs preserve stored case.

Public slots are the sorted, deduplicated **union of complete start/end intervals** offered
by eligible hosts, using the existing availability engine's local-time and DST rules.
Different grids can contribute different intervals. The 20,000-candidate budget is shared
across the configured pool; a larger pool can require a shorter search range. No response
maps a slot to particular hosts or discloses their private schedules. Public event metadata
uses the team name and omits `host.timeZone`; invitees view offered times in their own zone.

A configured host who has left, been deleted, or lost verified status is ineligible. An
otherwise eligible host without a default schedule, with a conflicting booking/busy block,
or over their buffer/daily limit is normally unavailable. Exact
`calendar_sync_unavailable` failures can be skipped when another host offers a fresh slot.
When no host offers a slot and at least one calendar could not be evaluated, the request
fails with `calendar_sync_unavailable`; a definitely unavailable pool returns no slots or
`slot_unavailable` for creation. No eligible host makes the event publicly unavailable.
Unknown database, parsing, authentication or provider errors abort; they are not silently
treated as normal unavailability.

For a new booking, the transaction recomputes the requested interval for every eligible
host and selects the available host with the smallest persisted last-assigned sequence.
Normalized UUID breaks ties. Only a committed new booking advances the per-event sequence.
A new member starts at zero and can receive one priority turn; subsequent turns use the
same least-recent sequence ordering, without lifetime-count catch-up.

Replays, failed transactions, cancellation and rescheduling do not advance fairness.
Deleting booking history does not rewind it. Mode switches, reactivation, and pool edits
preserve the event counter and every retained member's last sequence. A removed/re-added
member is a new pool entry. Values remain exact PostgreSQL `bigint` values and are never
included in public JSON or converted to JavaScript `Number`.

The booking result and management response include safe
`assignedHost: { "name": "...", "timeZone": "..." }`. The confirmation uses this actual
selection. It contains no host UUID, email, calendar ID or availability map. If that host
is later deleted, `assignedHost` can be null. Only the selected host enters `booking_hosts`,
the immutable required-host snapshot, calendar targets and host notification recipients.
The invitee and allowed guests retain existing behavior. Retries do not create additional
calendar imports, notifications, webhook snapshots, or a different selected person.

## Changes to existing bookings

Pool/mode edits affect new bookings. Rescheduling keeps the original selected host and
uses that person's current default schedule plus the event's current duration/rules. It
never chooses a substitute from the current pool. An immutable
`hosts_use_default_schedule` snapshot retains this policy even if the type is later changed
to individual with a custom schedule. A departed, deleted or unverified original host
prevents rescheduling; cancellation remains possible. Calendar updates and ICS attachments
retain the existing booking-chain UID across retries, moves and cancellation.

## Persistence and concurrency

Migration `0020_round_robin_assignment.sql` adds durable `round_robin_state`, retained
`event_type_hosts.last_assigned_sequence`, and immutable
`bookings.hosts_use_default_schedule`. It does not activate existing configurations. Known
collective snapshots containing more than one required host are backfilled to default
schedule mode while preserving every old field, including `updated_at`. Historical host
identities already lost before migration 0019 cannot be reconstructed, so a one-host
historical snapshot cannot reliably be inferred to have once been collective.

New bookings pre-read the complete configured pool, lock the organization lifecycle and
all pool host advisory locks in normalized UUID order, then share-lock/recheck event
configuration and current user/member eligibility. If the event still exists but the pool
changed while the booking waited, it returns retryable `409 booking_changed`; fetch current
availability and retry. It never appends new host locks to a changed lock set. The per-event
fairness row is locked after the event, and selection,
counter/last-sequence changes, the booking, required snapshots and all delivery enqueues
commit atomically. Overlapping pools use the same host locks as individual/collective
bookings, protecting buffers and daily caps across event types. Configuration/activation
uses the existing organization → event → current actor/host → state protocol and retains
authorization locks through commit.
