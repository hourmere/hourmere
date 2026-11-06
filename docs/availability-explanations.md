# Availability explanations

Availability explanations are an opt-in engine and scheduling-service capability.
There is no REST route, MCP tool, CLI command or administration page yet. Ordinary
availability continues to use its existing fast path.

## Typed contract and candidates

`@hourmere/core` exports `explainAvailability(ExplainAvailabilityInput)`,
`ExplainedSlot`, `AvailabilityReason` and the ordered
`AVAILABILITY_REASON_CODES`. It is pure: schedules, intervals, event rules,
range and `now` are inputs; there is no I/O or clock read. `blockingBookings`
retains conflicts from other event types without counting them toward booking
limits. `candidateStarts` lets the team service evaluate another host's grid.

`@hourmere/scheduling` exports
`explainEventAvailability(context, ExplainEventAvailabilityQuery)`. The query
contains `eventTypeId`, `rangeStart`, `rangeEnd` and optional `durationMinutes`.
Each result contains `start`, `end`, `status` (`available` or `unavailable`) and
`reasons`. Instants remain `Temporal.Instant` values in this internal typed
contract; future transports should serialize them using the existing UTC format.

Candidates combine the local-midnight step grid and every working interval's
anchored step grid, with duplicate starts removed. All candidates fit completely
inside the requested range. This includes non-working dates and hours, while
preserving starts anchored at unusual times such as 09:15. A candidate inside
working hours but outside their anchored grid receives `off_slot_grid`. Date
overrides replace weekly hours. Nonexistent DST starts are skipped and ambiguous
starts use the earlier occurrence, matching ordinary availability; meeting lengths
always measure elapsed minutes. A valid length absent from the offered list gets
`duration_not_offered`; malformed inputs remain validation errors.

Core callers can set `maximumCandidates` to bound distinct starts before reason
evaluation. The service applies its shared 20,000-candidate budget to each host
and to the combined grid evaluated across hosts. Explanation ranges include
past and out-of-window candidates, so their full range counts toward this budget;
requests may need smaller ranges than ordinary availability requests.
The service rejects range ends after `9999-12-01T00:00:00Z`, the existing ordinary
service's safe upper bound, instead of reporting bookable diagnostic slots beyond it.

Available candidates have an empty reason list. Filtering the results to
`status === 'available'` yields exactly ordinary availability for the same valid
offered duration, range, clock and database snapshot. Collective events require
every host; round-robin events require one eligible host. Host grids are combined
before each host is evaluated. Reasons from unsuccessful round-robin hosts are
omitted when another host can offer the slot.
An empty eligible round-robin pool uses a UTC diagnostic grid and reports the pool
reason plus known slot-wide rules. It does not invent working hours or other
host-specific facts for a missing eligible host.

Reasons use the following stable order; multiple reasons and multiple affected
sub-intervals can apply. Exact duplicates are removed, then intervals sort by start
and end (team results first break ties by authorized host ID).

| Code | Meaning |
| --- | --- |
| `past` | Start precedes `now`. |
| `duration_not_offered` | Selected valid duration is absent from the offered list. |
| `outside_working_hours` | The full meeting does not fit one resolved working interval, including date overrides. |
| `off_slot_grid` | Start is inside working hours but off their configured step grid. |
| `minimum_notice` | Start is before the configured notice cutoff. |
| `booking_window` | Start exceeds the host-local calendar-day booking window. |
| `calendar_busy` | The meeting itself overlaps a conflict-checking calendar interval. |
| `buffer_before` | A before-buffer on the candidate or an existing booking contributes a conflict. |
| `buffer_after` | An after-buffer on the candidate or an existing booking contributes a conflict. |
| `daily_limit` | This event type has reached its booking count on the host-local start date. |
| `weekly_limit` | This event type has reached its booking count in the host-local ISO week (Monday through Sunday). |
| `monthly_limit` | This event type has reached its booking count in the host-local calendar month. |
| `host_conflict` | The meeting itself overlaps another active booking, in any organization or event type. |
| `collective_member_unavailable` | A required collective host cannot offer the candidate. |
| `no_eligible_round_robin_host` | No eligible pool member can offer the candidate. |

## Privacy boundary

An explanation is a projection of scheduling rules, never a calendar or booking
record. Reasons contain a stable code and a nonempty blocking time interval
clipped to the candidate slot. They never contain calendar event titles, attendees,
locations, external event IDs, calendar IDs, booking IDs or invitee information.
The scheduling layer constructs the projection from an explicit field allowlist.

The entire service is manager-only and accepts `ServiceContext`: personal event types
require their owner acting in the event type's organization; team types require current,
verified owner/admin membership in a non-personal organization. API keys require `full`
scope. Public callers, other organizations, ordinary members, former administrators,
and `read`/`bookings` keys receive the same `not_found` outcome as a missing event type.
Team managers may see host identifiers. Even an empty eligible round-robin pool is
explainable only to its managers, with `no_eligible_round_robin_host`.
Transports must use the scheduling service, rather than publishing raw engine inputs,
database rows or a caller-supplied permission flag. Future REST, MCP, CLI and admin
consumers must retain this manager-only boundary. Any future public explanation must
not return busy/conflict intervals.

Blocking intervals express the part of the candidate affected by a constraint.
For buffer-only conflicts the raw busy interval can lie outside the candidate;
its influence on the candidate is clipped instead. Clipping limits each reason to its
candidate, but repeated candidates can reveal busy timings; this is why the entire
service is manager-only. Rules applying to the entire candidate use its full interval.

Unknown provider readiness must remain an error or neutral unavailable state.
It must never be described as missing working hours, a missing calendar or a known
busy event. Explanations do not refresh providers or make external requests.

## Extension points

Daily, weekly and monthly counters use booking starts in the host's schedule time
zone, with the same boundaries as ordinary availability. The scheduling input loads
the complete local weeks and months containing candidates, including bookings
outside the requested range. Future booking rules must extend the typed reason
order, explained-rules inventory and parity generator together.

The next transport task should add REST, MCP, CLI and administration consumers
using the same typed service result and authorization boundary. Localized display
text belongs in those consumers; engine reason codes are machine-readable values.
