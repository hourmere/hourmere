# Team administrator booking fields

This page fixes the data boundary for team administrators from the team access policy.
`GET /api/v1/team/bookings` lists bookings of the browser session's current team, including
bookings hosted by other members. It requires the shared `teamManagementAccess` middleware:
a current verified session and a current exact owner/admin role in a non-personal organization.
Ordinary members, personal organizations and API-key callers receive the same
`403 team_management_access_denied`; missing authentication returns `401 unauthorized`.
The route preserves the shared caller middleware's Origin/Referer handling.

The scheduling service exports `listTeamAdminBookings`, `TeamAdminBookingSchema`,
`TeamAdminBookingPageSchema`, their inferred types and `toTeamAdminBooking`.

List items and details use the same explicit whitelist:

| Field | Purpose |
|---|---|
| `id` | Identify the booking to inspect or coordinate cancellation. |
| `status` | `confirmed` or `cancelled`, including cancelled reschedule predecessors. |
| `start`, `end` | Stored booking instants in UTC. |
| `cancelledAt` | Cancellation instant, or null. |
| `eventType` | `{ id, title }` for the team activity; title is null for a deleted activity, and the object is null when no association remains. |
| `hosts` | Saved booking hosts as `{ userId, name }`, preserving the actual assignment rather than exposing the current event host pool. |
| `attendees` | `{ name, email, timeZone, isBooker }` for the invitee and guests: contact, scheduling and booker identification needed for coordination. |

The list envelope contains only `data` and opaque `nextCursor` (null on the last page).
It accepts the existing booking filters: start `from` inclusive and `to` exclusive,
`endAfter` exclusive and `endTo` inclusive, and `status` (`confirmed` or `cancelled`).
`order` is `asc` by default or `desc`; `limit` is 1–100, default 50. Follow `nextCursor` as
`cursor`, keeping the same filters and order. Pages use stored start time with microsecond
precision and ID as an exclusive keyset boundary. Inserts before that boundary do not shift
later pages; new rows after it can appear. Collective bookings occupy one row regardless of
their host count. Reschedule predecessors remain `cancelled`, with successors listed as
their own bookings; reschedule-chain identifiers are excluded.

The internal validation schemas are strict, including the nested activity, hosts and
attendees. The published response schemas use the same fields and remain open for additive
v1 changes. The mapper constructs new objects and arrays from named fields; it does not
filter, extend or spread the host booking DTO.

All custom answers are excluded: no question has been classified as essential for team
administration. Management tokens and hashes, personal calendar copies, calendar names,
private events and busy-time contents, credentials, conference organizer identity and
owner-only retry/start capabilities are excluded. Free-text booking titles and cancellation
reasons, attribution identifiers and reschedule-chain identifiers are also outside this
minimum whitelist.

No location or conference URL is returned, including an otherwise ready participant URL.
Team administration alone does not establish participant-link visibility. This rule also
excludes stale, pending, failed, cancelled and replaced conference links without depending
on asynchronous provider cleanup. Any future link field needs an explicit visibility
contract and current booking/conference snapshot checks before expanding this whitelist.

`TeamAdminBookingRecord` is an internal read model, not an authorization result. Before
calling the mapper, the route applies the shared team-management access check and the
service rechecks current access, scopes every booking to the authorized team, reads current
booking state, and loads only that booking's hosts and attendees. Event metadata comes from
its associated event type in that team, with a null title after soft deletion. Existing host,
public, management-token and agent interfaces keep their contracts. This endpoint grants
read access only.
