# Team booking handoff after host departure

[Booking handoff](https://hourmere.com/docs/booking-handoffs) is an opt-in feature. Hourmere also offers a [departure impact preview](member-departure-impact.md),
[safe self-departure](member-leave.md), and [administrator cancellation and manual rebooking](team-admin-bookings.md).
Ordinary rescheduling requires the original saved hosts and returns `booking_hosts_unavailable`
when a required host is gone. A handoff changes who will host a future appointment, so it
requires a new booking chain and fresh participant consent.

## Decisions

1. A current team owner or admin proposes a replacement. The confirmed source keeps its slot
   while consent is pending. Creating, viewing, declining, expiring or withdrawing an offer
   never cancels a booking, holds another slot or changes team membership.
2. Both the booker and every distinct guest mailbox on the source must explicitly approve
   the same offer version before apply. Normalize and deduplicate addresses using the booking
   mail recipient rules, while preserving attendee rows. Opening a link, an ICS RSVP, silence,
   or approval by somebody else gives no consent. A decline ends the offer and leaves the
   source confirmed. One non-responding guest blocks the whole handoff until the offer expires.
3. Once everyone has approved, a current owner or admin explicitly applies the offer. In one
   transaction, cancel the source, preserve its original host snapshot, and insert a fresh
   confirmed root in an independent booking chain. Record the handoff, delivery intents and
   consent evidence. Record the applying administrator separately from the proposer.
4. Phase one supports only single-host individual bookings in non-personal teams. The
   source must be the current confirmed leaf of a future, locally managed, unpaid,
   standalone appointment, with the departing host as its sole saved required host.
   An administrator can designate that host before self-departure or after removal.
   The target is the same active event type after repair, with `scheduling_type = 'individual'`
   and `booking_mode = 'individual'`, exactly one configured host who differs from the
   departing host, and no payment requirement.
   Collective and round-robin bookings remain out of scope even if the event type has
   since changed to individual. Exclude started meetings, imported records, payment holds,
   paid bookings, group seats, series occurrences, poll-linked bookings, missing host
   snapshots, unmanaged conference URLs, and any booking with a routing snapshot
   (`has_routing_snapshot`). Copying a routing snapshot would expose routing answers to
   the new host. Also exclude event types that are disabled, deleted or no longer accept
   equivalent attendee data. Use the existing cancellation or offline coordination guidance
   for these cases, as applicable.

Leave and removal retain their existing rules. Safe leave still checks current event and
booking dependencies. Administrative removal may already have happened. It supplies no
consent to hand off appointments and leaves their saved hosts intact. The administrator
handles each booking individually.

## Authorization and participant consent

Proposal, internal offer status, resend, withdrawal and apply require the shared team-management
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
controls. Cap confirmation-link sends at three per normalized recipient mailbox per source
booking, including the initial send and sends across offer versions. Under the offer and
recipient locks, recheck that the version is live and the recipient still owes a decision.
Consume one send from the durable cap and atomically revoke all older links for that
recipient before minting the new digest. Only the latest link is valid. Count a send with
ambiguous delivery against the cap. Claim each send intent once: duplicate jobs neither
mint a new digest nor revoke a potentially delivered current link. A current administrator
can explicitly resend to a recipient who has yet to answer. A resend of the same version
leaves its terms and other recipients' recorded approvals intact. Once the cap is reached,
use manual rebooking if required consent cannot be obtained.
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

Reading via the link leaves consent unchanged. Accept or decline by explicit POST. The emailed
link is a bearer capability for that mailbox's decision, so the page and email must say to
keep it private. Keep secrets out of query strings, logs, analytics, job payloads and
administrator responses. Use a fragment, clear it before fetching, and use a no-referrer,
no-store page and responses. Limit offer and mail volume and verification attempts. Invalid,
expired and revoked links use neutral recovery. A manage token, team session, API key or MCP
grant cannot answer for a participant. A participant capability cannot apply the handoff,
read either booking's management data, change the target or answer for another recipient.

An offer expires at the earliest of 48 elapsed hours after issue, the source start and the
proposed start. Reissuing an offer revokes the previous version and its approvals.
The per-recipient send cap still applies, and a fresh version requires a send available for
every recipient. Keep one live offer for a source and stop offering decisions once it is
committed, declined, expired, withdrawn or superseded.
A successful decision consumes the private link. Reusing it returns the unavailable-link
response. Applying twice returns the same limited result after authorization.
The result excludes management tokens, conference links and provider details.
Internal administrator status shows outstanding approvals and neutral failure states within
the existing [team booking field boundary](team-admin-bookings.md).

The administrator UI keeps Apply disabled while any approval is outstanding and explains
that a single unanswered guest keeps the handoff blocked. Show the offer deadline, whether
a resend is available and that only the newest link works. Explain that the existing
booking stays confirmed if the offer expires. On the participant page and in the email,
explain that the booker and every guest need to confirm before the team can replace the
booking. Offer a bounded resend or a fresh version if available, and point the administrator
to manual rebooking when someone cannot respond or delivery is exhausted.

## Data model and atomic apply

Use separate organization-scoped offer, recipient-consent and committed-handoff records.
Each committed handoff has one source booking and one distinct replacement booking with
same-team foreign keys, unique source and replacement references and an immutable edge.
Make the edge an internal audit relationship. Ordinary booking chain traversal, management
tokens, provider writeback and notifications never follow it.

| Existing fact or design rule | Contract |
| --- | --- |
| Source booking | Cancel the existing record normally to release occupancy. Preserve `required_host_user_ids` and the original host assignments. The existing immutability trigger remains active. |
| Replacement chain | Insert a new booking with `rescheduled_from_id = NULL`, a fresh `required_host_user_ids` snapshot and new management capabilities. |

Keep earlier source-chain rows, attendees, answers, provider history and mail receipts under
their existing retention and deletion rules. Do not store duplicate attendee data in the
committed edge. Keep the opaque booking/team identifiers, actor and offer identifiers,
timestamp, and consent outcome evidence. Expire unneeded offer data and capability digests
in bounded cleanup. Follow existing deletion and privacy rules for dependent records.
The source's manage links resolve only within the old chain, whose terminal booking is
cancelled. New links authorize only the new chain. Ordinary future rescheduling of that
chain follows its own new root and host snapshot. No handoff path may issue an
`UPDATE` of `required_host_user_ids`. Keep old booking and email token hashes, provider
references and private join URLs, routing snapshots and answers, waitlist attribution,
follow-up host notes, no-show data and SMS consent on the source chain. Copy only validated
booking details and the approved attendee information from the source. Resolve notification
settings and follow-up content afresh from current configuration.

Use one read-committed write transaction with the organization lock taken directly in share
mode through the shared team-management path. Membership writes take the exclusive lock. Follow the existing actor and organization
ordering, then lock the source booking before the offer and the sorted advisory host locks.
Take host locks for the sorted union of the sole saved source host and the sole configured
replacement host. Lock and reread current event and eligibility facts in the established
order. Serialize membership, leave, event edits and duplicate applies.
Refuse a changed host set instead of adding a late lock. Consent and offer
invalidation use the same organization → source → offer lock order when they touch those
rows. See the [team lock order](data-model.md#team-membership-and-host-lock-order).

Under these locks recheck current team access, phase-one eligibility, source state and start,
exact version and every unexpired approval. For source eligibility, require exactly one saved
host and `hosts_use_default_schedule = false` to exclude saved collective or round-robin
assignments. Check `has_routing_snapshot = false` at proposal and again at apply. Re-read the
event configuration and the participant-visible terms. Cancel the source to release its
local occupancy, perform the fresh admission check below, and insert the replacement in
the same transaction. Backstop apply with uniqueness
and the existing booking-host exclusion constraint. Any refusal or failure before commit
rolls back source cancellation, occupancy changes, replacement, receipts, and queued
delivery work. Provider and mail I/O runs after commit.

## Real availability

Use the normal admission and schedule evaluator with the **current** event configuration.
Check that the sole configured replacement host is still a verified, eligible team member,
including current SCIM suspension restrictions where applicable. Use the individual event's
effective schedule for that host.

Proposals show offered slots and reserve nothing. At apply, validate the exact start and end,
supported duration, working hours, exceptions, schedule time zones and DST, minimum notice,
booking window, booking limits, buffers and active occupancy. Use fresh local conflict
snapshots for the replacement host's selected calendars. Exclude only the local source
occupancy being retired and exact provider copies demonstrably mapped to that source chain
on the replacement host's calendar.
No broad time-window exclusion or exclusion of unmapped busy events. If required calendar
facts are stale or unreadable, refuse with calendar availability unknown. If an unrelated
conflict arises or the eligible host, logistics or offered time changes, apply fails.
A different proposal requires new consent.

The internal dry run checks one proposed slot for the repaired event's sole host. It uses
the original start and duration unless a different start or supported duration is supplied.
It judges the exact start on the event type's current slot grid. An off-grid start is
unavailable even when the replacement host is free. If conflict data cannot be trusted,
it reports `calendar_sync_unavailable`. Busy intervals, event mappings and provider
identifiers stay private.
This read-only check reserves nothing and sends no invitations. Applying a handoff requires
a fresh check under the write locks described above. The staged administrator preview uses
this same evaluator.

## Provider and notification identities

| Surface | Source chain | Replacement chain |
| --- | --- | --- |
| Google Meet and calendar copies | Reconcile cancellation against the pinned root, organizer account, destination and old provider event IDs. | Establish new writeback targets. For Meet, pin the new sole host as organizer and use their eligible, owned Meet-capable write destination. |
| Automatic Zoom | Cancel using the original pinned Zoom meeting-grant connection and external Zoom user identity. | For a supported individual booking, require the new sole host's own eligible meeting-mode grant and pin its external Zoom user identity. |
| Microsoft Outlook and Teams | Reconcile the old root's pinned `booking_calendar_targets.microsoft_writeback` state. Remove the Outlook event that carries the Teams meeting, or the ordinary Outlook copy, using the old owner's Microsoft connection, saved event mapping and old Graph `transactionId`. | If the new sole host's effective destination is Outlook, pin that calendar for the new root. For Teams, recheck `requireMicrosoftTeamsHost` in admission and start the new root's writeback with `teamsStatus: pending` and its own Graph `transactionId`. |
| ICS | Send `METHOD:CANCEL` with the original root UID and saved calendar organizer, at the cancelled leaf's depth plus one. If the historical identity is unavailable, send text only. | Send `METHOD:REQUEST` with the new root UID, `SEQUENCE:0` and independently pinned calendar organizer. Its mailbox may be the same configured sender as before. |
| Notifications | Resolve stale reschedule requests, retire pending reminders, follow-ups, SMS and old workflow timers, and enqueue ordinary cancellation. | Enqueue ordinary creation/confirmation and rebuild eligible reminders, follow-ups and workflows using the new schedule, configuration and recipients. Require fresh SMS opt-in before scheduling SMS. |

Google/Zoom organizer pins, provider event or meeting IDs, conference revisions and join
URLs belong to their own root. Provider organizer ownership is separate from the iTIP
`ORGANIZER` mailbox. Use the existing automatic-conference eligibility checks before apply.
A known ineligible connection requires a new offer with supported logistics. A transient
post-commit creation failure follows the normal bounded provider recovery path. While it
is pending or failed, follow the existing confirmation/failure policy, with no stale join
URL or misleading calendar attachment. Old cleanup uses only the old authorized grant.
If revoked access or ambiguous creation leaves an orphan, surface a safe status and direct
the original authorized provider owner to clean it up. A provider failure cannot roll back
either booking or give an administrator organizer credentials or start/retry capabilities.

Microsoft cleanup uses the destination and writeback history already pinned on the old
root even if the host's default calendar changes. Use the existing verified Graph delete
and bounded lookup for an ambiguous create or a moved copy. If the departing host's
Microsoft grant is revoked, report unresolved cleanup without exposing provider details.
The original account owner can reauthorize the same connection where possible or remove
any remaining copy in Outlook. If disconnection removed the target, only manual cleanup
in Outlook is available. The replacement host's credentials cannot be used to reconcile
the old event.

For a new Teams booking, admission requires Microsoft calendars to be enabled on the
instance and the new host to have an eligible owned Microsoft destination with
`Calendars.ReadWrite`. If either check fails, return `location_unavailable`. After commit
the worker checks Teams support on that exact calendar before writing. The old chain's
private `teamsJoinUrl` is never copied to the replacement chain. Keep the last validated
URL on the old root for eligible
cancellation mail recipients. Each email uses its own root's state and recipient policy.
For `join_url_pending`, `teams_unavailable` and `writeback_failed`, the cancellation
describes the old link's status and the confirmation describes the new link's status.
Neither status notice includes a join URL. Retry a pending new link against the same new
event, keep the ordinary Outlook copy when Teams is unavailable, and keep the Hourmere
booking when writeback fails. See [Microsoft Calendar](../apps/site/src/content/docs/docs/microsoft-calendar.md#add-microsoft-teams-to-an-event-type).

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
explain the replacement. Notices may arrive out of order. The distinct UIDs allow calendar
clients to reconcile either order. Old host mail follows current eligibility, so a removed
host may receive no app notice. Follow existing mail budgets, recipient eligibility and the
known in-flight SMTP duplicate window. See the [notification guide](notifications.md),
[conference storage rules](data-model.md#automatic-conferences) and
[iTIP storage rules](data-model.md#booking-calendar-email-identity).

## REST, MCP and CLI surfaces

| Operation | REST | MCP and CLI |
| --- | --- | --- |
| Propose and inspect | `POST /api/v1/team/bookings/{id}/handoff-offers`, `GET /api/v1/team/bookings/{id}/handoff-offers/{offerId}` | Browser session only. |
| Resend a pending recipient's link | `POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/resend` with the offer-scoped recipient identifier | Browser session only. |
| Withdraw or apply the approved version | `POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/withdraw` or `/apply` | Browser session only. |
| Read own terms and answer | `POST /api/v1/booking-handoffs/offer`, `POST /api/v1/booking-handoffs/answer` with the recipient capability in the body | MCP `read_booking_handoff_offer` and `answer_booking_handoff_offer`. CLI `booking-handoff offer` and `booking-handoff answer` via JSON input. The recipient capability is required in every transport. |

The REST routes use shared services and explicit OpenAPI IDs and operation scopes.
Administrator operations use the session-only exemption in
[`scripts/interface-parity.json`](../scripts/interface-parity.json). Register the two
recipient operations with real MCP/CLI mappings, following the meeting-poll
capability pattern. Scope tool discovery and direct calls as booking read/write
respectively. Valid agent credentials only permit transport usage and confer no recipient
authority. A supplied invalid bearer fails without fallback. Existing departure preview,
REST booking management, MCP reschedule and CLI reschedule gain no new capability.

## Failure and recovery

| Situation | Outcome |
| --- | --- |
| A recipient declines, never approves, or uses a superseded link | No booking write. A silent guest blocks apply and the offer expires with the source still confirmed. Use the latest link, a bounded resend or reissue, or manual rebooking as applicable. A different offer needs new approvals. |
| The administering session is revoked, switched or demoted, or the source starts, is cancelled or moves before apply | Refuse. Reauthorize in the correct team or reassess the current booking. A started meeting remains offline coordination. |
| A new host leaves, is suspended, becomes busy, or provider eligibility changes | Refuse and preserve the source. Recheck current readiness and propose again. Calendar uncertainty is reported as unknown. |
| Concurrent apply, cancel or reschedule | At most one valid source transition. A committed apply replay returns the saved limited result without minting new capabilities or duplicating work. |
| Post-commit worker or provider failure | Keep both committed booking states. Reconcile only the affected root through its normal bounded jobs and safe status. |

## Operator rollout and retention

Handoff admission defaults to off. In an isolated test instance, configure a test SMTP
sink and set `DEPARTURE_HANDOFFS_ENABLED=true` on every web and worker process. Use the same
setting on the combined `all` process when it serves both roles. The bundled Compose worker
inherits the setting from the app, while a custom deployment must pass it explicitly to
both roles. Restart or recreate the processes together. Keep production at the default
until the operator has accepted the flow.

With the setting off, the booking detail and Teams settings hide handoff actions, team handoff endpoints
return `handoffs_disabled` for authorized callers, and participant capabilities return the
unavailable-link response. Offer email and automatic apply workers stop processing handoff
work. An ordinary booking cancellation or creation already committed by a handoff still
uses its ordinary notification and provider jobs. After switching on, use a current team
session to check existing run and proposal receipts before initiating more work. Deadlines
keep running while the feature is off.

The hourly offer cleanup runs in worker-enabled roles even with admission off. It closes
expired offers and clears their digests, then prunes mailbox and delivery rows beginning
48 hours after the offer deadline. Each pass considers up to ten batches of 100 versions.
Later passes pick up locked rows and any backlog. The source-specific hashed send counters
remain until deletion of the source booking. The retained offer version and committed
handoff receipt follow the source and replacement deletion rules. When the feature is on,
the automatic run recovery job also purges terminal run receipts after seven days in
bounded batches. See [handoff storage](data-model.md#departure-booking-handoff-storage).

中文：验收时在隔离测试实例配置测试邮件收件器，同时为 Web 和 Worker 设置
`DEPARTURE_HANDOFFS_ENABLED=true` 并一起重启或重建。合并运行的 `all` 进程只需设置一次。
生产在负责人验收完成前保持默认关闭。关停交接后，已提交的取消和新预约仍由常规任务处理，
提议和队列期限继续计时。每小时的提议清理在关停后仍执行，并从截止时间过四十八小时起分批
清理收件邮箱和投递记录。同一原预约的哈希发送计数保留至原预约删除。启用交接时，
队列恢复任务分批清理终态超过七天的队列回执。

## Test plan and implementation steps

Plan about one working day per row, including its acceptance checks. Split any row that
outgrows a day before scheduling it. Keep admission hard-off until the complete flow is
verified. Migrations use a reserved number, generated types and constraint coverage. Use
disposable PostgreSQL databases and fake provider/mail transports.

### Staged administrator flow

The browser and REST flows use the production PostgreSQL store. An authorized
owner or admin opens the source in **Team bookings** and selects **Preview handoff**. The preview
shows the proposed host, time and location type. The proposal form labels the saved host
**Original host** while they are still a team member and **Departed host** after they leave.
**Create proposal** sends invitations for
an available preview with no existing proposal. An optional start time overrides the original
time and is checked when the proposal is created. **Refresh handoff** shows the version,
expiry, and the decision, delivery and resend status for each recipient, identified by
their role. **Resend** and **Withdraw** require confirmation. If a resend result is uncertain,
refresh handoff status before retrying. The same browser tab remembers the request key for
that version and recipient until it receives a success or a definitive client error.
**New version** opens
a fresh proposal after decline, expiry or withdrawal. A slot judged unavailable on the current
event grid, calendar uncertainty, a changed offer, any outstanding approval, or an expired
offer prevents confirmation. An expired offer leaves the source intact. If a slot changed
since the preview, refresh it before trying again. A different offer requires fresh consent.

**Confirm handoff** rechecks the terms and exact slot under the write locks. It queues the
ordinary cancellation and confirmation for two independent booking chains. If the result is
uncertain, refresh to see the committed receipt before trying again. The receipt reports
meeting readiness and old cleanup status when available. Pending or failed provider work
leaves the booking changes committed. The corresponding provider account owner can follow
the ordinary recovery process for that account. If a calendar connection was removed
before the handoff, that account's owner must delete any remaining copies in that calendar.
The administrator sees no join links, provider identifiers or credentials in the handoff
results.

The preview GET is `/api/v1/team/bookings/{id}/handoff-preview`. Apply uses
`POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/apply` and the exact offer
`version` in the JSON body. Both bind the current browser session to
`X-Expected-Organization-Id`. A successful preview returns the safe slot, aggregate
consent state and deadline, or the limited committed receipt.

The administrator API can create and inspect proposals, withdraw a version, and resend
one pending recipient’s link. Create with the departing host ID and optional start, duration
and location choice. Pass the latest offer ID and version in `previous` to replace the terms.
The offer ID stays the same and the version advances. The previous version and its links
become inactive, and the new version requires every recipient’s fresh approval. Use the
optional `version` query parameter to inspect a specific historical version. Recipient
status includes the matching source booking attendee IDs for selecting whom to contact.
Use the current owner or admin browser session and include `X-Expected-Organization-Id`.
Resend and withdrawal require the browser's same-origin request. Submit `{version}` to
withdraw that version and revoke its links. The source booking stays confirmed.
When email is unavailable, the enabled server still serves status and withdrawal and
reports resend unavailable.

Send the version and opaque recipient ID to resend, with a random UUID in the
`Idempotency-Key` header. Retry the same recipient and version with the same key. The
worker rotates the link when it claims a new attempt. The first send and attempts with
uncertain delivery count toward the three-send cap per source booking and normalized mailbox.
An unavailable mailer or a shared-mail limit leaves the attempt unsent and preserves any
previously active link. A queued attempt that has not been claimed within 20 minutes can
be replaced by a fresh resend request. If SMTP was already in flight when an offer was
withdrawn or superseded, the recipient may still receive a message whose link is revoked.

### Staged participant flow

Open the private link from the offer email at `/booking/handoff` to see the current and proposed times,
hosts and location. The booker can also review their saved answers that would be
shared with the new host. Keep the link private. Opening the page records no decision.
Choose **Accept** or **Decline**, then submit. The source booking stays confirmed
until the team completes the handoff. It can do so only if the booker and every
distinct guest approve the same version. A decline closes that version and invalidates
its other links. An unanswered guest blocks the handoff through expiry.

An unavailable link shows one recovery message whether it expired, was withdrawn,
was replaced or was already used. Contact the team that sent the link if you still
need help. A fresh version requires a fresh decision from each recipient.

To review programmatically, send the private fragment token as `{token}` to
`POST /api/v1/booking-handoffs/offer`. To answer, send `{token, version, decision}`
to `POST /api/v1/booking-handoffs/answer` with the reviewed version and `accept` or
`decline`. The answer response contains the recorded decision. Both operations
return `404 handoff_offer_unavailable` for unavailable links or versions. A browser
session and an API key grant no participant authority. If a bearer is supplied, it
must be valid and have the scope for the operation. MCP and CLI also require their
usual connection credentials to reach these operations. Use `booking-handoff offer --input -`
and `booking-handoff answer --input -` with the same JSON fields on standard input.
Keep the token out of command arguments and logs.

The page clears the fragment before requesting the offer. It and the API responses
are served with no-store and no-referrer headers. Offer and answer operations share
a rate limit of 30 requests per minute per trusted IP bucket on each server process.
A committed handoff queues localized notices for both
bookings. Administrators can refresh the receipt to check email acceptance. See
[staged booking handoff mail](#staged-booking-handoff-mail).

中文：管理员可创建、查看、撤回和换版交接提议，也可向尚未决定的收件人重发私密链接。
同一源预约的每个规范化邮箱最多发送三次，包含首发和送达不确定的尝试。重试同一请求时请沿用
`Idempotency-Key`。撤回、过期或换版都会使旧链接失效，源预约仍保持确认。
参与者可用邮件里的私密链接查看原预约和拟议预约。预订人还可查看将分享给新主持人的已保存答案。
打开链接不会记录决定。请选择接受或拒绝，再提交。任何来宾拒绝或尚未回复都会阻止交接。
链接过期、被撤回、换版或已经使用时，页面统一提示联系发件团队。
REST、MCP 和 CLI 都需要邮件中对应收件人的私密令牌。MCP 和 CLI 的连接凭证只用于访问接口。
CLI 用 `--input -` 从标准输入读取 JSON，请勿将令牌放入命令行参数或日志。

交接提交后，后台任务使用原主持人固定的账户和日历清理旧条目，并在接任主持人符合资格时写入新条目。
如果原授权已撤销或无法核验清理结果，交接回执会提示原账户所有者检查日历或会议。新预约仍保持确认。
如果日历连接在交接前已被移除，该账户的所有者必须删除该日历中仍保留的副本。

Provider cleanup and creation reuse existing workers. Google Calendar, Meet, Outlook, Teams
and Zoom handoffs use real PostgreSQL and fake providers for lifecycle acceptance, including
revocation and ambiguous responses.

### Staged booking handoff mail

A committed departure handoff queues a cancellation for the original booking and a
confirmation for the replacement. Both notices explain the host change in the recipient's
mail language. A booker or guest may receive either notice first.

The cancellation uses the original calendar UID and saved organizer, with the sequence one
higher than the last version of that event. If the organizer was never saved, recipients get
a plain-text cancellation and may need to remove the original event from their calendars
manually. The replacement uses a fresh UID and starts at sequence zero. Its invitation and
manage link belong to the replacement booking.

The administrator receipt reports when the mail server accepts each notice for all
attendees. If the cancellation job finishes, is skipped, or exhausts its retries before
acceptance is recorded for every attendee, the cancellation status is **Email delivery
incomplete**. Refresh the handoff status after the background worker runs. Mail-server
acceptance does not confirm inbox receipt. Replaying a committed handoff does not queue
another notice.

### Staged automatic handoff runs

After a host has left, a current team owner or administrator can open **Automatic handoff**
from the departure review in **Team members**, or select **Manage automatic handoff** in an
affected booking. Select **Start automatic handoff for this departed member**. The
confirmation shows the ten-booking cap and the minimum ten seconds between bookings.
Use **Pause** or **Resume** to control the run. **Stop** requires confirmation and leaves
any remaining originals unchanged. Select **Refresh run receipt** to review each outcome.

For the REST operation, pass a fresh UUID as `runId` and the former host's account ID as `departingUserId`
to `POST /api/v1/team/bookings/handoff-runs`. Read the receipt at
`GET /api/v1/team/bookings/handoff-runs/{runId}`. Use `POST` to the same path with
`/control` appended and an `action` of `pause`, `resume` or `stop`. All operations require
the browser's current team session and `X-Expected-Organization-Id`. Writes require a
same-origin request. The routes and background processing require `DEPARTURE_HANDOFFS_ENABLED=true`.

A run records up to ten live proposals that already have every recorded recipient's
approval, starting with the earliest expiry. It reuses those offers and their prior link
deliveries. The worker processes one saved version per transaction, with at least ten seconds
between attempts. One run per team can be running or paused, and new runs start at least
one minute apart. Repeating the start with the same run ID and departing host returns the
existing receipt. A worker restart resumes from the same saved versions. A manual apply
that won the source lock can supply the same committed receipt without creating a second
replacement. Each apply rechecks the complete recipient set, saved terms, slot and current
authority. The original booking keeps its saved host and identity.

Pause and stop take effect after any transaction already in flight. A running queue is
bound to the starting administrator's session or the session that most recently resumed it.
Before each due item, the worker checks that the former host is still absent and the session
still has access. Switching the session to another team or ending it fails the run with
`authorization_lost`. Resume a paused run from a current authorized session in the same team
to preserve the saved items and versions. After a terminal failure, start a new run from
that current session for the remaining eligible proposals once the cooldown allows it.
The run has a 30-minute deadline, including time paused. A completed run reports each item as applied,
ineligible or processing failed. A stopped or failed run marks the remaining items stopped.
Review any unapplied item in Team bookings and use the existing single-booking handoff or
manual recovery flow. Some bookings may have been outside the run or missing approvals.
Receipts are retained for seven days and contain only stored IDs, versions and status codes.
The team journal records run starts, pauses, resumes and terminal transitions.

中文：主持人离队后，当前团队所有者或管理员可确认启动一轮自动交接。每轮最多处理十笔
已经获得全部参与者同意的有效提议，逐笔提交，间隔至少十秒。同一团队同时只能有一轮运行或暂停，
新一轮启动间隔至少一分钟。每轮有三十分钟期限，包含暂停时间。用同一运行编号重试启动会取回
原回执。暂停或停止会在下一笔前生效。停止需要确认，尚未处理的原预约保持不变。
请从同一团队当前有权限的会话恢复已暂停的队列。
运行绑定启动或最近一次恢复的会话。该会话切换团队或结束时，下一笔到期处理会导致
`authorization_lost`，本轮失败。请用当前会话在启动间隔满足后，为其余合格提议开启新一轮。
原主持人重新加入团队时，本轮也会停止。请逐笔查看回执，用原有单笔交接或人工
恢复流程处理未完成的预约。未获同意和超出本轮上限的预约需另行处理。原预约保留原主持人及
原预约链身份。回执保留七天。

| Step | Deliverable and acceptance |
| --- | --- |
| 1. Storage | Add team-scoped offers, recipient consent and immutable handoff edges. Verify same-team references and uniqueness, upgrade preservation, deletion and retention, and the existing host-snapshot constraint. |
| 2. Offer and link delivery | Add the proposal and withdrawal service, eligible-source checks, and sensitive mail dispatch. Exercise individual-only admission and the exclusions, including routing snapshots. Verify that a deliberate send voids the recipient’s previous link, the three-send cap spans offer versions for the source booking, duplicate jobs mint no link, and unavailable delivery preserves the source. |
| 3. Consent service | Implement recipient-only terms and explicit version-bound decisions. Test scanner-safe reads, stale or forged links, mailbox isolation, permitted answer sharing, refusal, expiry and approval invalidation on reissue. |
| 4. Apply transaction | Cancel the current leaf and insert the independent root atomically. Verify rollback, unchanged source host snapshots, fresh management capabilities, all-recipient approval, and replay and race handling against another apply, cancel, reschedule or host departure. Exercise source-copy mutations for immutability, consent and team authorization. |
| 5. Availability recheck | Use the normal evaluator for the selected individual host. Test same-time replacement, stale or unreadable calendars, exact old-copy exclusions, unrelated conflicts and a competing booking. |
| 6. Old-chain provider cleanup | Reuse the pinned Google, Zoom and Microsoft cancellation paths. Use fakes to verify old-account ownership, Outlook copy and Teams cleanup under saved write-back state, bounded reconciliation for ambiguous writes, and safe status with revoked grants. |
| 7. New-chain provider creation | Pin current destinations and create fresh Google Meet, Zoom or Teams meetings under eligible new-host grants. Test Teams eligibility recheck, fresh Outlook write-back, pending and failed creation, and isolation from the old join URL and provider IDs. |
| 8. Notifications and ICS | Rebuild booking notifications and workflow timers from the lifecycle intents, including fresh SMS opt-in and stale-job suppression. Verify both mails for `join_url_pending`, `teams_unavailable` and `writeback_failed`, calendar UID and sequence in either delivery order, and ordinary webhook privacy and replay deduplication. |
| 9. REST, MCP and CLI | Connect the shared services to the proposed routes and recipient tools. Verify OpenAPI parity, browser-only management authorization, wrong-team rejection, agent credential boundaries and capability requirements across transports. |
| 10. Browser flow and rollout | Add the English and Simplified Chinese admin and recipient views and operator guidance. Browser-test proposal through apply and show that one silent guest blocks apply. Review the full flow and require green CI before enabling it. |

## Later scope

Collective and round-robin handoff requires a separate design for multi-host availability,
Google Meet organizer selection, candidate locks and assignment state. Phase one rejects
those bookings and leaves their ordinary booking flows in place.

## 中文摘要

管理员先提出交接，由原预约的预订人及每个不同的来宾邮箱分别确认同一版本。确认期间旧预约
继续占用原时段。任何一位来宾未回复都会阻止交接，直到提议到期。每个收件邮箱对同一原预约
最多收到三次确认链接，重发后只有最新链接有效。首期仅支持单主持人的个人模式团队预约，
不支持带路由快照的预约。管理员提交时，系统复核团队权限、实际主持人、工作时间、日历冲突和
会议授权。通过后在同一事务内取消旧预约并创建新链，保留旧记录与原主持人快照。
内部试算按活动类型当前的可预约时段网格检查指定开始时间。即使接任者有空，网格之外的开始
时间也不可预约。试算不占用时段、不发邀请。日历数据不可信时返回
`calendar_sync_unavailable`，不会公开私人忙碌区间或日历事件映射。正式应用需在锁内重新检查。
团队所有者或管理员可按[中文操作指南](https://hourmere.com/docs/booking-handoffs#中文操作指南)在浏览器完成验收。
在**团队预约**打开原预约，点**试算交接**，核对接任主持人、时段和地点类型，然后点**创建提议**。
点**刷新交接状态**查看版本与收件人状态。按需点**重发**或**撤回**并确认，或在拒绝、过期或撤回后点**新版本**。
等预订人和每位来宾都同意同一版本，点**确认交接**。提交结果不确定时，先刷新查看回执，再决定是否重试。
主持人离队后，在**团队成员**的离队审查启动自动交接，点**暂停**、**恢复**、**停止**并刷新查看逐笔结果。
提交后，外部会议仍可处于待创建或失败状态，由对应主持人使用原有恢复流程处理。
提议操作、确认链接投递、参与者页面和接口均需启用交接功能，默认关闭。
交接提交后，系统会排队发送原预约取消邮件和新预约确认邮件，管理员可刷新回执查看投递状态。
若取消邮件任务已结束、被跳过或耗尽重试，且仍有参与者缺少邮件服务器接受记录，回执会显示邮件投递未完成。
旧会议的取消沿用原 ICS UID 与原日历组织者，新邀请使用新 UID。Google Meet 和 Zoom
按各自预约链的固定组织者身份处理。Outlook 和 Teams 按旧链固定的写回状态清理，新 Teams
会议要求实例启用 Microsoft 日历，并复核接任主持人的写入资格。任一条件不满足时返回
`location_unavailable`。旧入会链接仅供旧链的取消邮件使用。
