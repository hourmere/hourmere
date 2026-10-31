# Member departure impact

`GET /api/v1/team/members/{memberUserId}/departure-impact?teamId={teamId}` is a read-only
preview for leave or removal flows. It requires a current verified browser session
acting in that non-personal team. An ordinary member can inspect only themselves; a current
owner or admin can inspect any current member of that team. Roles are parsed as exact
comma-separated tokens from the database. Missing, removed and inaccessible targets all
receive `403 team_management_access_denied`. Missing or invalid sessions receive the same
403 without a `WWW-Authenticate` challenge. Any Authorization header is denied before
credential resolution, even alongside a valid cookie; API keys and MCP grants cannot
acquire this capability.

The route uses `teamManagementAccess.memberReadMiddleware`; the scheduling service
`getTeamMemberDepartureImpact` independently checks the current session, expiry, active
organization, verified identity, actor role and target membership. It reads authorization,
counts and pages in one repeatable-read snapshot. Direct service callers supplying an
existing transaction retain its isolation level and must provide their own consistency
guarantees or locks. Each request rechecks current facts,
including after removal, demotion or an organization switch. This preview grants no authority
to leave, remove, edit hosts or cancel. A later write must check its own current permissions
and impact in its write transaction.
The [safe team departure service](member-leave.md) performs that recheck under the shared
team write locks before revoking the caller's membership.

The response contains `evaluatedAt` and two independently paginated collections:

| Collection   | Scope and fields                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventTypes` | Undeleted team event types currently configured with the target as a host, including disabled types. Each item has `id`, `title`, `slug`, `schedulingType`, `isActive`, `reason` and `remainingHostCount`.           |
| `bookings`   | Confirmed bookings in that team with the target among the saved booking hosts and `end > evaluatedAt`. Each item uses the [team administration whitelist](team-admin-bookings.md), plus `inProgress` and `handling`. |

Event reasons are `sole_host` for individual types, `round_robin_pool_member` for round-robin
pools, and `collective_required_host` for collective types. Removing someone from a current
host pool changes the event list, while bookings retain their saved host assignments.
`remainingHostCount` counts other configured hosts who are still verified members of that
same team. A round-robin pool with `remainingHostCount: 0` has the same no-host severity as
`sole_host`; the reason value remains `round_robin_pool_member` for compatibility.
Personal event types, bookings belonging to personal event types, personal organizations
and other teams are excluded. Bookings whose team event type was deleted remain visible;
soft-deleted event titles are null, as in the administration whitelist. Bookings with no
remaining event association are included when their team and saved host match.

`inProgress` means `start <= evaluatedAt < end`, using stored microsecond precision.
Its `handling` is `wait_until_end_or_coordinate_offline`: wait until the meeting ends or
coordinate offline. A future booking has `handling: coordinate_cancellation`, meaning
coordinate through an independently authorized cancellation flow under its existing time
rules. These labels do not promise cancellation permission. Existing cancellation semantics
reject bookings that have already started; this preview does not relax them. Cancelled
bookings and bookings ending exactly at the evaluation instant are excluded. No booking is
automatically cancelled or reassigned, and no notifications or provider calls occur.

Each collection contains `data`, `nextCursor` and `totalCount`. `totalCount` counts all
matching rows, independent of the cursor and page limit. `eventTypesLimit` and `bookingsLimit`
default to 50 and accept 1–100. Follow `eventTypes.nextCursor` as `eventTypesCursor` and
`bookings.nextCursor` as `bookingsCursor`; keep team, member and limits unchanged. The cursors
are independent and null on each collection's final page. Event types use an exclusive UUID
boundary; bookings use precise stored start time and UUID. Inserts before a boundary do not
shift the next page. Each request recalculates results and counts, so configuration changes,
new bookings, cancellations and elapsed time can change later pages. There is no cross-request
snapshot or guarantee that previously returned rows remain actionable.

Queries page event and booking rows with `limit + 1`, count in SQL, and load participants only
for the returned booking IDs. They do not load entire tables into application memory or read
private calendar names, titles, contents or full free/busy. Booking answers, tokens, credentials,
conference links and personal calendar copies stay outside the inherited whitelist. Internal
validation schemas are strict leak-test boundaries; every published response object remains
open for additive changes within API v1.
