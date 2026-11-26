# Team booking handoff after host departure

Proposed contract. The current product offers a [departure impact preview](member-departure-impact.md),
[safe self-departure](member-leave.md), and [administrator cancellation and manual rebooking](team-admin-bookings.md).
Ordinary rescheduling requires the original saved hosts and returns `booking_hosts_unavailable`
when a required host is gone. A handoff changes who will host a future appointment, so it
requires a new booking chain and fresh participant consent.

## Decisions

1. A current team owner or admin proposes a replacement. The confirmed source keeps its slot
   while consent is pending. Creating, viewing, declining, expiring or withdrawing an offer
   never cancels a booking, holds another slot or changes team membership.
2. The booker and each distinct guest mailbox on the source explicitly approve the same offer
   version. Normalize and deduplicate addresses using the booking mail recipient rules, while
   preserving attendee rows. Opening a link, an ICS RSVP, silence, or approval by somebody else
   gives no consent. A decline ends the offer and leaves the source confirmed.
3. Once everyone has approved, a current owner or admin explicitly applies the offer. In one
   transaction, cancel the source, insert a fresh confirmed root, and record the handoff and
   delivery intents. Record the administrator who applies it separately from the proposer and
   the evidence of participant consent.
4. First release supports future, locally managed, unpaid, standalone appointments in
   non-personal teams. The source must be the current confirmed leaf and identify the departing
   host in its saved snapshot. An administrator can designate a saved host before their
   self-departure or after removal. The target is the same active event type after repair,
   still in individual booking mode and with no payment requirement. The departing host
   must be absent from its current configured host pool. Unsupported
   cases include started meetings, imported records, payment holds or paid bookings, group
   seats, series occurrences, poll-linked bookings, missing host snapshots, unmanaged
   conference URLs, and event types that are disabled, deleted or no longer accept
   equivalent attendee data. Use the existing cancellation or offline coordination guidance
   for these cases, as applicable.

Leave and removal retain their existing rules. Safe leave still checks current event and
booking dependencies. Administrative removal may already have happened. It supplies no
consent to hand off appointments and leaves their saved hosts intact. The administrator
handles each booking individually.

## Authorization and participant consent

Proposal, internal offer status, withdrawal and apply require the shared team-management
boundary. Require a verified, unexpired browser session in the non-personal team, exact
current owner/admin role, same-origin write checks and any current SCIM/SSO requirements.
Require `X-Expected-Organization-Id` on administrator writes and recheck it under the write
locks. Any Authorization header takes the agent credential boundary and receives
`403 team_management_access_denied`, including when a valid cookie is present. Membership
or host status by itself gives no management authority. A missing or cross-team source or
offer receives the same not-found response after team authorization. Apply rechecks the
acting administrator's own authority, even if somebody else proposed the offer.

Bind each purpose-specific, expiring capability digest to one recipient, offer and version.
Queue a recipient record ID. The delivery worker mints the opaque secret at send time,
persists only its digest and sends it to the saved address under the existing mail
controls. Use a worker claim per recipient and offer version. Duplicate jobs must leave a
potentially delivered link and any recorded decision valid. If delivery is ambiguous and
the recipient cannot answer, an administrator can issue a fresh offer version.
Mark these messages `sensitive: true`. If mail delivery is unavailable, report an unsent
offer and preserve the source booking. The log mailer cannot establish delivery.
Bind consent to the exact source and target terms, including time and time zone, duration, actual host set,
location kind and participant-visible logistics, recipient set, and the booking answers that
will be shared with those hosts. Show the recipient only their own status and the terms
needed to decide. Other attendees' addresses, answers, phone numbers, private calendar facts,
and provider identifiers, credentials or links stay outside the offer response. If approval
covers sharing required answers, show the booker which saved answers will be shared with the
new hosts through their own authorized flow. Refuse incompatible questions or answers and
use manual rebooking when the current form requires new information.

Read via the link without changing consent; accept or decline by explicit POST. The emailed
link is a bearer capability for that mailbox's decision, so the page and email must say to
keep it private. Keep secrets out of query strings, logs, analytics, job payloads and
administrator responses. Use a fragment, clear it before fetching, and use a no-referrer,
no-store page and responses. Limit offer and mail volume and verification attempts. Invalid,
expired and revoked links use neutral recovery. A manage token, team session, API key or MCP
grant cannot answer for a participant. A participant capability cannot apply the handoff,
read either booking's management data, change the target or answer for another recipient.

An offer expires at the earliest of 48 elapsed hours after issue, the source start and the
proposed start. Reissuing an offer revokes the previous version and its approvals.
Keep one live offer for a source and
stop offering decisions once it is committed, declined, expired, withdrawn or superseded.
Repeat submission of the same decision can return the saved outcome without another
side effect. Applying twice returns the same limited result after authorization; the
result supplies no management token, conference link or provider details.
Internal administrator status shows outstanding approvals and neutral failure states within
the existing [team booking field boundary](team-admin-bookings.md).

## Data model and atomic apply

Use separate organization-scoped offer, recipient-consent and committed-handoff records.
Each committed handoff has one source booking and one distinct replacement booking with
same-team foreign keys, unique source and replacement references and an immutable edge.
Make the edge an internal audit relationship. Ordinary booking chain traversal, management
tokens, provider writeback and notifications never follow it.

| Existing fact or design rule | Contract |
| --- | --- |
| Source hosts | Preserve `required_host_user_ids` and the original host assignments. The existing immutability trigger remains active. Cancel normally to release occupancy. |
| Replacement chain | Insert a new booking with `rescheduled_from_id = NULL`, a fresh `required_host_user_ids` snapshot and new management capabilities. |
| Participant consent | Every distinct booker and guest mailbox must explicitly approve the exact offer version before apply. |

Keep earlier source-chain rows, attendees, answers, provider history and mail receipts under
their existing retention and deletion rules. Do not store duplicate attendee data in the
committed edge. Keep the opaque booking/team identifiers, actor and offer identifiers,
timestamp, and consent outcome evidence. Expire unneeded offer data and capability digests
in bounded cleanup; follow existing deletion and privacy rules for dependent records.
The source's manage links resolve only within the old chain, whose terminal booking is
cancelled. New links authorize only the new chain. Ordinary future rescheduling of that
chain follows its own new root and host snapshot. Never transfer old booking or email
token hashes, provider references, no-show data, or SMS consent. Copy only validated
booking details and the approved attendee information from the source.

Use one read-committed write transaction with the organization lock taken directly in update
mode through the shared team-management path. Follow the existing actor and organization
ordering, then lock the source booking before the offer and the sorted advisory host locks.
Take host locks for the complete pre-read union of source and target event hosts, including
the round-robin candidate pool. Lock and reread current event and eligibility facts in the
established order. Membership, leave, event edits and duplicate applies must serialize;
never add a late host lock to the pre-read sorted set. Consent and offer
invalidation use the same organization → source → offer lock order when they touch those
rows. See the [team lock order](data-model.md#team-membership-and-host-lock-order).

Under these locks recheck current team access, source state and start, exact version and
every unexpired approval. Re-read the event configuration and the participant-visible
terms. Cancel the source to release its local occupancy, perform the fresh admission check
below, and insert the replacement in the same transaction. Backstop apply with uniqueness
and the existing booking-host exclusion constraint. Any refusal or failure before commit
rolls back source cancellation, occupancy changes, replacement, receipts, and queued
delivery work. Provider and mail I/O runs after commit.

## Real availability

Use the normal admission and schedule evaluator with the **current** event configuration.
Check that each selected host is still a verified, eligible team member, including current
SCIM suspension restrictions where applicable. Individual events use the selected configured
host; collective events require all current configured hosts. Round robin proposes an
eligible host via its ordinary assignment inputs and pins the displayed host for consent.
Recheck assignment eligibility under its state lock, failing if normal selection would pick
another host. Advance assignment state only on successful admission.

Proposals show offered slots and reserve nothing. At apply, validate the exact start and end,
supported duration, working hours, exceptions, schedule time zones and DST, minimum notice,
booking window, booking limits, buffers and active occupancy. Use fresh local conflict
snapshots for selected calendars. Exclude only the local source occupancy being retired and
exact provider copies demonstrably mapped to that source chain on a selected host's calendar.
No broad time-window exclusion or exclusion of unmapped busy events. If required calendar
facts are stale or unreadable, refuse with calendar availability unknown. If an unrelated
conflict arises or the eligible host set, logistics or offered time changes, apply fails.
A different proposal requires new consent.

## Provider and notification identities

| Surface | Source chain | Replacement chain |
| --- | --- | --- |
| Google Meet and calendar copies | Reconcile cancellation against the pinned root, organizer account, destination and old provider event IDs. | Establish new writeback targets. For Meet, pin an eligible configured organizer and owned Meet-capable write destination. An individual or round-robin appointment uses its assigned host, and a collective appointment uses its configured organizer among its required hosts. |
| Automatic Zoom | Cancel using the original pinned Zoom meeting-grant connection and external Zoom user identity. | For a supported individual booking, require the new sole host's own eligible meeting-mode grant and pin its external Zoom user identity. |
| ICS | Send `METHOD:CANCEL` with the original root UID and saved calendar organizer, at the cancelled leaf's depth plus one. If the historical identity is unavailable, send text only. | Send `METHOD:REQUEST` with the new root UID, `SEQUENCE:0` and independently pinned calendar organizer. Its mailbox may be the same configured sender as before. |
| Notifications | Resolve stale reschedule requests, retire pending reminders, follow-ups, SMS and old workflow timers, and enqueue ordinary cancellation. | Enqueue ordinary creation/confirmation and rebuild eligible reminders, follow-ups and workflows using the new schedule, configuration and recipients. Require fresh SMS opt-in before scheduling SMS. |

Google/Zoom organizer pins, provider event or meeting IDs, conference revisions and join
URLs belong to their own root. A retained organizer who still qualifies may be selected
by the current configuration and create a new event under the same authorized account.
Provider organizer ownership is separate from the iTIP
`ORGANIZER` mailbox. Use the existing automatic-conference eligibility checks before apply.
A known ineligible connection requires a new offer with supported logistics. A transient
post-commit creation failure follows the normal bounded provider recovery path. While it
is pending or failed, follow the existing confirmation/failure policy, with no stale join
URL or misleading calendar attachment. Old cleanup uses only the old authorized grant;
if revoked access or ambiguous creation leaves an orphan, surface a safe status and direct
the original authorized provider owner to clean it up. A provider failure cannot roll back
either booking or give an administrator organizer credentials or start/retry capabilities.

Use two transactional lifecycle intents, `booking.cancelled` for the old booking and
`booking.created` for the new one, with ordinary webhook privacy, workflow switches and
stable delivery keys. Give each email intent a private handoff marker for its own role so
templates can explain the change without traversing the edge or expanding public payloads.
The existing old-mail suppression for normal reschedules must not classify a handoff
cancellation as superseded. When the old calendar organizer snapshot is unavailable, the
handoff cancellation skips the attachment and skips pinning a fallback organizer.
Workers check booking status and conference
revision before sending. Retain the old delivery history and dedupe replay independently
on each root. Invitees and guests receive a cancellation and a separate confirmation that
explain the replacement; notices may arrive out of order. The distinct UIDs allow calendar
clients to reconcile either order. Old host mail follows current eligibility, so a removed
host may receive no app notice. Follow existing mail budgets, recipient eligibility and the
known in-flight SMTP duplicate window. See the [notification guide](notifications.md),
[conference storage rules](data-model.md#automatic-conferences) and
[iTIP storage rules](data-model.md#booking-calendar-email-identity).

## Proposed REST, MCP and CLI surfaces

| Operation | REST proposal | MCP and CLI |
| --- | --- | --- |
| Propose and inspect | `POST /api/v1/team/bookings/{id}/handoff-offers`, `GET /api/v1/team/bookings/{id}/handoff-offers/{offerId}` | Browser-session-only; no tool or command. |
| Withdraw or apply the approved version | `POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/withdraw` or `/apply` | Browser-session-only; no tool or command. |
| Read own terms and answer | `POST /api/v1/booking-handoffs/offer`, `POST /api/v1/booking-handoffs/answer` with the recipient capability in the body | `read_booking_handoff_offer` and `answer_booking_handoff_offer`; CLI `booking-handoff offer` and `booking-handoff answer` via JSON input. The recipient capability is required in every transport. |

Use shared service operations and explicit OpenAPI IDs and operation scopes. Register
administrator writes with the existing session-only exemption in
[`scripts/interface-parity.json`](../scripts/interface-parity.json). Register the two
recipient operations with real MCP/CLI mappings, following the meeting-poll
capability pattern. Scope tool discovery and direct calls as booking read/write
respectively; valid agent credentials only permit transport usage and confer no recipient
authority. A supplied invalid bearer fails without fallback. Existing departure preview,
REST booking management, MCP reschedule and CLI reschedule gain no new capability.

## Failure and recovery

| Situation | Outcome |
| --- | --- |
| A recipient declines, never approves, or uses a superseded link | No booking write. The current or expired offer state gives the administrator guidance; a different offer needs new approvals. |
| The administering session is revoked, switched or demoted, or the source starts, is cancelled or moves before apply | Refuse. Reauthorize in the correct team or reassess the current booking; a started meeting remains offline coordination. |
| A new host leaves, is suspended, becomes busy, or provider eligibility changes | Refuse and preserve the source. Recheck current readiness and propose again. Calendar uncertainty is reported as unknown. |
| Concurrent apply, cancel or reschedule | At most one valid source transition. A committed apply replay returns the saved limited result without minting new capabilities or duplicating work. |
| Post-commit worker or provider failure | Keep both committed booking states. Reconcile only the affected root through its normal bounded jobs and safe status. |

## Test plan and implementation steps

Each row is a separate one-day implementation step. Keep admission hard-off until the
complete flow is verified. Migrations use a reserved number, generated types and constraint
coverage. Use disposable PostgreSQL databases and fake provider/mail transports.

| Step | Deliverable and acceptance |
| --- | --- |
| Storage and guards | Add scoped offer, consent and edge storage. Verify DB constraints and existing snapshot immutability, same-team uniqueness, legacy/deleted data and retention. |
| Propose and consent | Implement live browser authorization and capability endpoints. Test manager, member, former member, other team, wrong organization, API key/OAuth, stale/forged capabilities, per-mailbox privacy, forwarding boundaries, scanner-safe reads, mailer redaction and unavailable delivery, decline and version invalidation. |
| Apply and admission | Exercise atomic cancel/new root with real availability, retained history, and fresh token isolation. Cover same-time moves, collective and round-robin eligibility, stale calendars, busy mirrors, simultaneous host departure, duplicate apply and competing booking/cancel/reschedule writes. Source-copy mutations must fail when immutable-host, consent or organization protection is removed. |
| Calendar and notifications | With provider fakes verify pinned old cleanup and fresh Google/Zoom creation, organizer revocation and ambiguous failure, stale job behavior, old/new ICS UID and sequence in either order, webhooks and workflow lifecycle, and rebuilt notifications with fresh SMS opt-in. |
| Surface, UI and rollout | Verify REST/MCP/CLI parity and browser-only exemptions, then browser-test current admin, booker and guest flows. Ship English and Simplified Chinese UI/mail and operation docs. Review and run CI before enabling the feature. |

## 中文摘要

管理员先提出交接，由原预约的预订人及每个不同的来宾邮箱分别确认同一版本。确认期间旧预约
继续占用原时段。管理员提交时，系统复核团队权限、实际主持人、工作时间、日历冲突和
会议授权。通过后在同一事务内取消旧预约并创建新链，保留旧记录与原主持人快照。
旧会议的取消沿用原 ICS UID 与原日历组织者；新邀请使用新 UID。Google Meet 和 Zoom
分别按各自预约链的固定组织者身份处理。任何预约或日历状态不明时，页面按实际状态说明。
