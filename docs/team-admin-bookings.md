# Team administrator booking fields

Card 581 / TS02 implements the data boundary from the approved team policy contract
(card 580). There is no team-administrator booking endpoint yet. The scheduling service
exports `TeamAdminBookingSchema`, `TeamAdminBookingPageSchema`, their inferred types and
`toTeamAdminBooking` for the future endpoint.

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
Each object schema is strict, including the nested activity, hosts and attendees. The
mapper constructs new objects and arrays from named fields; it does not filter, extend
or spread the host booking DTO.

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
calling the mapper, the future endpoint must apply the shared access check from card 583,
scope every booking to the authorized team, read current booking state, and load only that
booking's hosts and attendees. Event metadata must come from its associated event type
in that team, with a null title after soft deletion. List paging and detail lookup belong
to that authorized service. This change adds no endpoint and no session, role or caller
logic; existing host, public, management-token and agent interfaces keep their contracts.
