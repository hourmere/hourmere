# Safe team departure

`POST /api/v1/teams/{teamId}/leave` accepts an empty JSON object and requires a current,
verified browser session. Bind the action to its original team with
`X-Expected-Organization-Id`. Missing or changed context returns
`409 organization_context_changed`; reload before retrying. Missing or invalid sessions
and any present Authorization header receive `403 team_management_access_denied` without
a `WWW-Authenticate` challenge. Authorization-bearing requests are rejected before
credentials are resolved, including when accompanied by a valid session cookie.

`leaveTeamMember` reuses `checkTeamManagementAccess`, allowing ordinary members to act on
themselves. In a read-committed transaction it takes the existing user → organization →
member → session locks, then checks owner continuity and calls
`getTeamMemberDepartureImpact` on that same transaction.
The organization write lock conflicts with the organization share locks used by event-type
and booking writers. Dependencies committed while departure waits are therefore included
in the recheck, and no new dependency can commit between that check and membership deletion.
The preview endpoint remains a read, never authorization to leave.
The REST route also shares the native organization-context advisory lock before taking
row locks. A source-bound automatic switch waiting behind leave rechecks the personal
fallback and returns 409; a leave contending with a switch returns 409 promptly. Native
HTTP departure retains its existing outer context lock without reacquiring it on another
connection.

An owner may leave only while another current member has an exact `owner` role token.
This check runs after the organization write lock, serializing simultaneous owner leaves
and role changes. Removal and role changes retain a defensive owner count under this same
lock in their membership write transaction, after enforcing the owner-target refusal.
The REST refusal is
`409 member_departure_owner_required` with
`message: "The team must retain at least one owner."` and
`handling: { "owner": "another_owner_is_needed_before_you_can_leave",
"nextStep": "add_another_owner_first" }`. The existing owner value remains compatible;
`nextStep` gives the shared recovery step for departure, removal and demotion.
Legacy comma-separated roles are trimmed and matched by exact tokens. Another owner
does not bypass the event and booking impact rules.

An affected event type (including a disabled one) or a confirmed booking whose end is still
in the future blocks departure. HTTP 409 has `error: member_departure_blocked`, `message`,
`impact` and `handling`. `impact` is the existing departure-impact projection, with bounded
first pages, total counts and independent cursors. Use the
[departure-impact endpoint](member-departure-impact.md) to read remaining items. The
handling values are:

| Field | Value and next step |
|---|---|
| `eventTypes` | `ask_admin_to_replace_or_remove_host`: an administrator repairs the listed host assignments. |
| `futureBookings` | `coordinate_cancellation`: coordinate through an independently authorized cancellation flow, retaining its existing time rules. |
| `inProgressBookings` | `wait_until_end_or_coordinate_offline`: wait for the meeting to end or coordinate offline; retry after its end. |

With no impact, membership deletion, the `member_removed` operation record and the current
session's personal-organization fallback commit together. The response is
`{ "organizationId": "<personal organization UUID>" }`. Other sessions and team-bound
credentials lose access through the existing current-membership checks. Stale web drafts
retain their old expected organization and cannot write into the personal space or old
team. Bookings and their saved hosts remain unchanged.

Better Auth's `/api/auth/organization/leave` and self-directed
`/api/auth/organization/remove-member` persistence calls invoke this same service through
the launch role-policy adapter. Blocked native responses retain Better Auth's shape:
`{ "code": "member_departure_blocked", "message", "impact", "handling" }`. The server
composition root supplies the scheduling callback; standalone authentication instances
without it fail closed with `503 TEAM_LEAVE_UNAVAILABLE`. The adapter refreshes the native
handler's session snapshot after success so its later cleanup retains the committed
personal fallback. Administrative removal continues through its existing path.

The native adapter maps the shared locked owner refusal to the same 409 code and handling
in Better Auth's `{code,message,handling}` shape. The HTTP response boundary also maps
Better Auth's earlier sole-owner 400 refusals to this stable 409 response for teams.
The native early checks remain intact; writes that reach persistence still recheck owner
continuity under the lock. Concurrent leaves, demotions and removals serialize on the
same organization row. Two owners leaving at once can commit only one departure.
Forbidden owner-target requests cannot change membership while a leave waits.
Personal-organization owner guards remain in place.

Only a current verified owner may assign `admin` or `member` to a non-owner.
Owners cannot be demoted, including by themselves, or administratively removed.
Owners may remove admins and members; admins may remove members only. Owner-target
requests receive the uniform team access denial before any write; only the owner’s own
safe departure is allowed. REST immediate removal refuses self targets; use safe departure
for dependency checks and the personal fallback.
Assigning an owner role and full ownership transfer remain unavailable at launch.
`/organization/delete` is refused with `403 TEAM_OPERATION_NOT_SUPPORTED` for HTTP and
trusted server-side calls before any booking-history cascade. There is no separate
ownership-transfer endpoint on this instance.
