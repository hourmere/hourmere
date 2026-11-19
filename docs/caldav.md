# CalDAV connections

Hourmere's Calendars page connects CalDAV accounts through browser-session-only REST
operations. Encrypted credentials, guarded discovery, bounded busy reads, incremental
sync and conditional booking writes use the existing calendar services and background
jobs. See the bilingual [setup guide](https://hourmere.com/docs/caldav).
Real-account compatibility remains pending: tests use synthetic Nextcloud-style and
iCloud-style responses, not real provider accounts.

## Credentials and ownership

CalDAV uses HTTP Basic authentication over verified HTTPS with a separate app password.
This integration has no OAuth flow, browser login, password refresh or connection to
Hourmere sign-in. Ask for a server URL, provider login name and app password; never ask
for a primary Apple Account password or a two-factor verification code. Providers may
support other authentication methods; those are outside this adapter's scope.

`createCalDavCredentialRecord` builds an insertable `calendar_connections` record using
the existing `caldav` provider and `credentials` bytea column. No migration is needed.
The encrypted, versioned JSON contains the canonical server URL, username and password.
The external account identity is an unsalted SHA-256 hash of the canonical server
URL/username tuple. It omits plaintext inputs from connection metadata, but anyone with
the hash can confirm a guessed provider URL and username offline. This is a stable
deduplication identifier, not a confidentiality boundary. Keeping the existing hash
preserves the uniqueness constraint across encryption-key rotation without rewriting
account identities; confidentiality relies on access controls and encrypted credentials.
This identifies the submitted
endpoint/login, not a globally verified person: aliases or different server paths can
represent the same provider account. The connection identity does not reconcile such
aliases; do not equate them using email addresses.

Encryption reuses `packages/calendars/src/credentials.ts`: AES-256-GCM with a fresh
96-bit nonce, authenticated tag and version byte. The dedicated
`CALENDAR_ENCRYPTION_KEY` is a canonical base64 encoding of 32 random bytes. Associated
data binds the CalDAV provider, owner, row ID and external account identity. Copying
ciphertext to another row/owner or changing its identity fails authentication. This is
separate from Better Auth's encrypted sign-in OAuth tokens and auth secret.

Only internal provider code may decrypt for an immediate request. Creation returns the
insertable encrypted record, never a plaintext password; discovery returns metadata,
never credentials. Do not put passwords, Authorization headers, XML bodies, provider
response bodies or credential-bearing URLs into logs, telemetry, error causes, jobs or
API responses. The internal reader necessarily exposes plaintext to trusted calling
code; it is not a public API. Decrypted credential objects and discovery request
objects redact username/password and Authorization fields under `JSON.stringify`,
`util.inspect` and `String()`. Protected fields use non-enumerable getters: object
spread, `Object.entries` and `structuredClone` omit them. Repeated redaction is safe.
Direct field access remains usable internally and must not be logged; explicitly
copying those field values creates unprotected plaintext. These protections apply to
objects returned by the credential reader and wrapped discovery requests, not raw
caller-supplied credential literals.
Keep plaintext lifetime short; JavaScript does not provide
a reliable guarantee of memory zeroization. Back up the encryption key separately from
the database. Losing it requires reconnecting; rotation must explicitly decrypt and
re-encrypt records with both keys available, not simply replace the environment value.

The connection service authorizes the owner's live browser session before
network access and rechecks it before saving. Successful discovery precedes transactional
persistence of encrypted credentials and VEVENT calendar metadata. Connections belong to
the user across organizations; a team administrator gains no access to another user's
connection. Agent credentials cannot create or replace provider credentials in this step.
Credential discovery, connection and replacement are browser-session-only REST
operations declared in OpenAPI. They are explicitly exempt from MCP/CLI write parity:
API keys and MCP OAuth cannot submit provider credentials. Do not give an agent your
provider password or add a credential-accepting MCP tool.

`POST /api/v1/calendar-connections/caldav/discover` accepts the URL, username and
password (and optional reconnect ID), checks live ownership, and returns sanitized
names, capabilities and opaque selection keys without persistence. Provider URLs and
credentials are not returned. `POST /api/v1/calendar-connections/caldav` accepts the
same credentials and explicit inventory/conflict/destination selections, performs fresh
discovery, and saves them atomically. Reconnect requires re-entry of all three fields;
stored credentials are never prefilled. Reconnect must preserve the canonical endpoint
and username identity; an account/endpoint change requires disconnect and a new connection. Existing list, selection, sync and disconnect
operations apply the CalDAV owner-session boundary as well.

`connectCalDav` discovers and saves the chosen inventory; `listCalDavConnections`
returns only owner-scoped connection IDs/status and calendar IDs, names, colours,
read-only and availability flags. `disconnectCalDav` deletes the owner's connection
and its dependent calendars, including local encrypted credentials; provider-side app
password revocation remains the host's action. Disconnect stops future sync and writes,
removes local busy snapshots and write mappings, and leaves already written events on
the provider unchanged. Delete those events in the provider if desired; Hourmere can no
longer update or cancel them after disconnect. Reconnect keeps connection and calendar
IDs stable and replaces credentials using the existing row's authenticated encryption
identity. A failed discovery leaves the prior inventory untouched.

Successful reconnect transactionally queues a finite write-recovery pass for this
connection's pinned booking chains and group slots. Recovery walks at most 100 targets
per page, including cancelled bookings, and queues ordinary conditional reconciliation
against current booking state. It preserves the original destinations and ownership
checks; it does not override external edits or recreate disconnected mappings. Recovery
pages have five bounded retries, rather than an indefinite reset of the write retry budget.

No migration is needed: `calendars.sync_state.caldavDiscovery` stores version 1
metadata (`available`, `color`), not an event sync cursor. Deselected or removed
collections retain their identity with `available: false`; reconnect never deletes
pinned references. Calendar conflict selection defaults to false, and discovery never
sets `last_synced_at` or changes a booking destination.

Calendar collection hrefs are provider identities. Discovery returns nullable display
names, normalized `color` (`#RRGGBB` or `#RRGGBBAA`), and advisory `canWrite` flags;
missing or invalid colours are null, and missing privileges never imply write access.
The caller explicitly supplies collection URLs to include in the saved inventory;
unknown, duplicate or explicitly non-VEVENT selections are refused. This is inventory
selection only. Discovery does not establish that event bodies can be read. The
`configureCalDavCalendar` service separately authorizes conflict selection; booking
destinations are selected through `configureCalDavWriteCalendar`. Saving explicitly
selected calendars queues busy sync; production workers also dispatch periodic refreshes
and booking lifecycle writes.

连接服务：先验证本人有效会话，再发现并以事务保存加密凭据及
支持 VEVENT 的日历。连接属于用户，切换组织不会转移所有权，团队管理员也不能
读取其他用户的连接。颜色缺失或无效时为 null；未确认权限不代表可写。
日历页通过仅限本人浏览器会话的 REST 接口连接，MCP、CLI 和 API 密钥不接受日历密码。
生产任务执行忙闲读取、增量同步及预约写回；尚未完成真实账号验收。

## Discovery

The protocol starts from the supplied HTTPS service endpoint. An origin-only endpoint
uses `/.well-known/caldav`; an explicit DAV path can be used directly. Follow the
current principal, its calendar home set, then enumerate immediate child collections:

1. Resolve the service endpoint with bounded, manually inspected redirects.
2. `PROPFIND`, `Depth: 0`, for `DAV:current-user-principal`.
3. `PROPFIND` the principal, `Depth: 0`, for
   `urn:ietf:params:xml:ns:caldav:calendar-home-set`.
4. `PROPFIND` the accepted home, `Depth: 1`, for collection type, display name,
   component support and privileges. Return calendar collections with explicit
   `supportsEvents` and `canWrite` capability flags. Future selection must exclude
   collections that explicitly exclude VEVENT; discovery does not select them.

These steps follow [RFC 6764 service discovery](https://www.rfc-editor.org/rfc/rfc6764.html),
[RFC 5397 current principal](https://www.rfc-editor.org/rfc/rfc5397.html), and
[RFC 4791 CalDAV properties](https://www.rfc-editor.org/rfc/rfc4791.html).
Do not construct a principal path from an email address or assume a collection is called
“Default.” Preserve escaped paths. Depth:0 accepts a matching response href modulo
one trailing slash, or a single same-origin response with a canonical context path.
Resolve relative response and property hrefs against the URI of the request that
returned the multistatus (after any redirects), following RFC 4918 §8.3. A canonical
response href selects the property group but does not change that base URI; this also
applies when a nested endpoint returns a 207 directly without a redirect.
The foundation intentionally does not implement DNS SRV/TXT discovery and uses only
the first returned calendar-home-set href; accounts with multiple homes need further
adapter work. The result does not establish read access to event bodies.

A 207 response can contain mixed outcomes. Only successful property groups count;
a missing/denied privilege is unknown, never a grant. For a collection explicitly
marked as a CalDAV calendar, an absent `supported-calendar-component-set` means all
component types are supported (RFC 4791 §5.2.3), so `supportsEvents` is true. An
explicit component set must include VEVENT. `canWrite` is an advisory indication of
advertised DAV `all`, `write`, `write-content` or `bind` privileges, not permission
for every booking operation; absent privileges produce false (no verified grant).
In particular, `bind` indicates creation and `write-content` indicates content changes;
future writes must check the privileges required by their specific operation.
Parse XML by namespace URI, not by prefix; reject malformed XML, DTDs and external
entities. Bound body size, nesting, response count, calendar count and redirects.
`createCalDavDiscovery(transport, { privateTargets, allowedOrigins })` exposes
`discover(credentials, signal?)` through `CalDavDiscoveryClient`. Discovery is stateless
and performs no database writes. Its injected transport permits
recorded XML fixtures and controlled failures without real provider network traffic.

### Outbound URL and credential protection

The discovery client reuses the webhook outbound URL/address policy, with a stricter
HTTPS-only boundary even for operator-approved private servers. Apply the policy to
initial URLs, redirect locations, principal/home hrefs and calendar hrefs, including
URLs returned as metadata for future use. Reject embedded userinfo, fragments, malformed
URLs and unsupported ports. Public destinations use DNS hostnames and HTTPS port 443.

Before **each** network request resolve all DNS answers, validate them all, and pin the
validated address to the socket while preserving the original hostname for Host, SNI
and certificate verification. This closes the validation/request DNS-rebinding gap.
A mixture of public and forbidden answers fails; never choose only the convenient
answer. The default policy excludes private, loopback, link-local, metadata, multicast
and other special-use IPv4/IPv6 ranges, including IPv4-mapped address tricks. No proxy
environment, cookie jar or automatic redirect forwarding may bypass this boundary.

Two independent trusted-operator decisions exist: which private host/network and port
may be reached (`privateTargets`), and which extra HTTPS origins may receive the
connection's Basic credentials (`allowedOrigins`). The application supplies these constructor options from operator-only
`CALDAV_PRIVATE_TARGETS` and `CALDAV_ALLOWED_ORIGINS`; they are never user-submitted fields. A private
network exception alone does not authorize cross-origin password forwarding; an origin
exception alone does not bypass the address guard. The original server origin is the
credential boundary by default. A cross-origin redirect or href fails closed unless
that exact origin is explicitly authorized; matching a registrable domain or a suffix
is insufficient. No wildcard provider trust is implied by a returned XML URL.

Private-target exceptions retain the existing guard's narrower policy: ordinary private
and loopback destinations can be opted in, but link-local and known cloud metadata
addresses remain forbidden even with an allowlist. Never disable TLS verification;
trusted private CAs must be installed by the operator in the process trust configuration.
No per-connection “accept any certificate” or self-signed-certificate bypass is offered.

### Bounds and failures

The production transport has a 10-second request deadline encompassing DNS, connection,
TLS, headers and response body; discovery has a 30-second overall deadline. It permits
up to three redirects per PROPFIND, 1 MiB per response, 10,000 XML elements, nesting
depth 32 and 256 calendar collections. The real transport aborts the network operation;
injected transports receive the abort signal and must honor it to release their own
resources. Serial discovery bounds concurrency. Automatic
retries are not part of discovery; the caller decides when to try again. Production
transport errors expose only the bounded `CalDavError.code` classification and a fixed
message; they carry no HTTP status, raw provider exception or response.

Connection troubleshooting distinguishes these states; these are protocol meanings,
not new translated strings or an API contract in this change:

| Condition | Meaning and host action |
| --- | --- |
| 401 | Credentials rejected; check the login name or generate a new app password. |
| 403 | Access refused; check provider permissions. Do not say that no calendars exist. |
| 429 | Provider throttled requests; retry later, respecting a bounded `Retry-After`. |
| DNS, timeout, TLS, 5xx | Connection could not be checked; keep existing configuration and mark freshness unknown. |
| Forbidden target/origin | Operator network policy prevented discovery; ask the operator to review the precise destination privately. |
| Invalid XML, missing principal/home, exceeded limits | Server response unsupported or incomplete; do not publish a partial calendar inventory as complete. |
| Successful discovery, no readable event calendars | No eligible event calendar was found in this successful response. |
| No writable calendar | Busy reads may be possible later; do not silently choose an unwritable booking destination. |

Rate-limit numbers for individual providers are not established by the sources below.
Do not promise a provider quota. Follow-up jobs should serialize per connection, bound
global concurrency, use exponential backoff with jitter for transient errors, cap
`Retry-After`, and stop retrying rejected credentials until reconnect. Never convert a
partial/failed busy sync into an empty, apparently free calendar.

## Busy synchronization

`createCalDavSyncClient` reads the selected collection through the discovery transport's
HTTPS, DNS pinning, exact-origin credential and redirect guards. It discovers advertised
sync support, captures a token before the initial bounded `calendar-query`, and requests
server-side `calendar-data/expand`. Later `sync-collection` reports identify changed and
deleted resources; bounded expanded `calendar-multiget` checks each returned etag against
the listing before applying changes. Invalid tokens or unsupported sync reports trigger
a complete bounded reconciliation. Without sync support, each refresh reconciles the
range and resource etags; ctag alone never proves a snapshot current. Incomplete, oversized,
malformed, permission-denied or inconsistent responses never establish an empty calendar.

`syncCalDavCalendar` serializes all calendars on one connection with a database row lock.
It parses every resource before publishing intervals and the opaque token together in
one transaction. `calendar_busy` retains only hashed instance identities and timed or
all-day intervals. `calendars.sync_state` retains version-2 coverage, discovery metadata,
resource href/etag mappings and hashed instance mappings; no event bodies, titles or
attendees are stored. The daily refreshed coverage is UTC midnight minus three days
through plus 403 days. The client accepts at most 410 days, 2,048 resources, 1 MiB per
response and 30 seconds per call. Sync network work has a 60-second deadline;
jobs expire after 120 seconds. Database lock waits and persistence are not interrupted
by the network abort signal.

Selection requires the owner's live browser session and respects the existing twenty
conflict-calendar limit. Calendar jobs use the existing Postgres job system, bounded
concurrency and exponential retry backoff with jitter. Wire selection and dispatch through
`createCalDavSyncEnqueuer(jobs)`: its per-calendar singleton key preserves delayed retries
and its optional transaction keeps initial enqueue atomic with selection. Rejected credentials stop retrying until
reconnect. The application registers these factories for production workers.
Failures retain the last snapshot and mark freshness unavailable. Availability and
readiness apply the same ten-minute freshness and range-coverage contract as Google;
failed or stale data cannot advertise free slots.

The parser consumes expanded instances, including server-resolved RRULE/RDATE/EXDATE
and RECURRENCE-ID exceptions. Unexpanded recurrence is unsupported and fails the refresh.
UTC, unambiguous IANA TZID times, and exclusive all-day dates are supported. Floating
values require an independently verified IANA calendar zone; raw `calendar-timezone`
VTIMEZONE metadata is not treated as verified. Embedded/custom VTIMEZONE definitions,
ambiguous or nonexistent local DST times and local calendar-day durations remain
unsupported unless the server expands them to usable UTC values. Transparent and
cancelled instances are excluded. Declines are excluded only with independently verified
calendar-user addresses; this sync service currently supplies none, so a declined event
conservatively remains busy. Provider usernames are never assumed to be email identities.

内部同步先读取有界且由服务器展开的事件，再使用已声明支持的 sync-collection
增量报告；令牌失效或服务器不支持时进行有界全量核对。忙碌区间与游标以事务一并
保存，不保存标题、参会者或原始事件。失败保留旧快照并标记暂时不可用；同一连接
串行同步。未经验证的浮动时区、未展开的重复规则及无法解释的 VTIMEZONE 会使同步
失败，不会被当作空闲。尚未验证本人日历地址时，已拒绝邀请仍保守地占用时间。
界面和仅限浏览器会话的 REST 已接入生产任务；MCP/CLI 不接收凭据，真实账号验收仍未完成。

## Synchronization and booking writes

### Calendar selection and freshness

After successful discovery, let the host explicitly choose readable calendars for
conflict checking and a single writable destination using the existing profile/default
and per-host event-type destination rules. Read all selected calendars, not just the
write destination. A write destination need not be selected for busy checking. Newly
discovered calendars must not silently become destinations; removed or permission-lost
calendars retain an actionable unavailable state until reconciled. Privilege information
is advisory and operations must handle permissions changing after discovery.

Persist calendar collection hrefs as provider identities and pin the booking's selected
destination using the existing `booking_calendar_targets` pattern. Never move an old
booking's event just because the host changes the default. Use the existing freshness
contract for selected busy calendars: a failed, stale or incomplete refresh cannot
make availability look free. Collective/round-robin readiness must retain their current
fail-closed/host-exclusion behavior, and unknown readiness must use neutral wording.

### REPORT strategy

Start with bounded `REPORT calendar-query` time ranges covering the scheduling horizon,
requesting only the fields needed for busy intervals and identifiers. The query's
matching logic does not itself guarantee that returned data has expanded recurrence
instances; explicitly request `calendar-data/expand` for the same bounded range.
Discover capabilities rather than assume every server implements the same extensions.
The protocol distinctions are specified in [RFC 4791](https://www.rfc-editor.org/rfc/rfc4791.html).

Later, use `sync-collection` only when advertised: persist its opaque sync token after
all changed/deleted resources have been applied atomically, use etags to detect changes
between listing and fetching, and restart a full bounded reconciliation when the token
is invalid. A collection sync token does not cover a moving scheduling horizon by
itself; periodically refresh the range and newly entering occurrences.
[RFC 6578](https://www.rfc-editor.org/rfc/rfc6578/) defines the sync report and invalid-token
recovery. Collection `ctag` is an optional change hint, not a portable correctness
guarantee. Without sync support use time-range reconciliation and resource etags;
do not infer a deletion from an incomplete, truncated or failed report. Store no event
summary, description or attendee information when busy intervals suffice.

### Recurrence and time zones

Prefer server-side `expand` initially. Check recurring masters, `RDATE`, `EXDATE`,
`RECURRENCE-ID` overrides, canceled instances, moved exceptions that cross the query
boundary, all-day recurrence and DST transitions before enabling a provider. Bound
instance count and expansion horizon; an oversized or unsupported series makes the
refresh incomplete rather than silently dropping conflicts.

There is currently **no general iCalendar recurrence/VTIMEZONE expansion engine** in
`packages/core`; the existing Google busy adapter relies on provider expansion. The
existing Temporal availability/interval code can consume normalized results and supplies
DST-aware calendar arithmetic, but cannot be presented as an RFC 5545 RRULE parser.
A client-side fallback therefore requires a separately reviewed iCalendar parser and
bounded expander, with differential server/client fixtures; until then a server that
cannot provide usable expanded results is unsupported for busy sync.

Honor embedded `VTIMEZONE` definitions for custom `TZID` values; do not assume every
TZID is an IANA zone or discard it in favor of the host's zone. UTC instants can be
consumed directly. Resolve floating local times only with a verified calendar timezone;
otherwise fail the refresh as ambiguous. Keep all-day dates and exclusive end dates as
dates, following `calendar_busy`'s existing date-range representation. A future client
parser must handle transition rules and reject unknown zone semantics rather than use
the machine's timezone. These data forms are defined by
[RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html). Initial single-booking writes can
use UTC DTSTART/DTEND, avoiding invented VTIMEZONE definitions.

### Idempotent writes and conflicts

Use a deterministic resource path beneath the pinned destination and `UID = booking id`
(the booking UUID). Initial creation is `PUT .../<booking-id>.ics` with
`If-None-Match: *`; persist href, UID and the acknowledged strong etag only after
success. A lost response is ambiguous: fetch the same resource and verify UID and
Hourmere ownership before recognizing a replay. Never create a second path to evade
a precondition failure. Do not overwrite an unrelated event with the same path or UID.

Updates use `If-Match` with the last observed etag; cancellation uses conditional
`DELETE`. A 412 requires fetching the current resource and deciding whether it is an
already-applied desired revision or an external edit. Never unconditionally retry a
write after a 412. Reconcile harmless provider normalization, but preserve genuine host
edits and surface a conflict requiring host action. A missing resource on delete is
success only for the known owned mapping. Permissions, quota and transient failures
remain distinct from concurrency conflicts.

Hourmere rescheduling creates a successor booking ID, but CalDAV keeps the **root booking
UUID** as UID and resource name for the whole chain. This supersedes the earlier planned
retire-and-create lifecycle: updates replace the same resource conditionally, with a
monotonically increasing SEQUENCE. Each written successor maps to that same href through
`booking_calendar_events`; destinations remain pinned in `booking_calendar_targets`.
Group slots own one resource independently of their seats, with a slot identity and count
revision. Collective hosts each receive a copy in their own pinned destination.

`configureCalDavWriteCalendar` authorizes the owner's live browser session and selects a
verified writable calendar as the profile default (or clears it). It does not move
existing pinned targets. The application wires `calDavBookingNotifier` into
the booking transaction and registers `calDavBookingJob`.
`writeCalDavBooking` reconciles a booking-chain or group-slot payload.

Writes and busy sync share the connection row lock, so only one request sequence runs
per connection. Internal jobs reconcile current database state rather than the queued
version. Bounded retry/backoff uses the existing job system. A successful replay verifies
the desired resource and performs no further PUT; a completed DELETE retains its mapping
with a null etag and cannot delete a later replacement. Missing resources during an update
are treated as a conflict, rather than silently recreating an externally deleted event.
Conflicts preserve server changes and require host reconciliation. The calendar stores
its latest write result and root identity in `sync_state.caldavWriteback`; successful busy
reads preserve this result and the neutral `provider_unavailable` connection status. Raw credentials, ICS bodies
and provider exceptions are never logged or included in errors.

An HMAC-SHA256 signature binds each generated VEVENT to the local calendar and its
semantic properties. This lets recovery recognize an unchanged earlier Hourmere revision
after a lost response, even when cancellation or a newer reschedule arrived before the
mapping committed. It uses a bounded fresh-ETag conditional retry, never an unconditional
write. Folding, property order and timestamp normalization are tolerated; changed content
or extra event properties remain conflicts. Encryption-key rotation cannot authenticate
an ambiguous old signed write: reconcile pending writes before rotating the key, or
resolve those conflicts explicitly afterwards.

Busy sync recognizes a calendar copy only from its persisted href mapping and expected
non-recurring UID. It uses the same external identity as the write mapping, allowing the
existing reschedule/group-slot exclusions to ignore that copy. An unrelated href with the
same UID remains foreign busy time.

中文：内部写回以预约链根 UUID 固定 UID 和资源路径，改期更新同一资源并递增
SEQUENCE；集体预约分别写入每位主持人的固定目标日历，团体时段只写一份共享副本。
创建使用 If-None-Match，更新和删除使用已确认的强 ETag。重放不会重复创建；
412 后重新读取并只认可已完成的目标版本，不覆盖外部修改。更新时发现资源已消失
会报告冲突；已知资源删除后的 404 可视为成功。失败仅报告中性不可用状态。

CalDAV calendar copies do not change Hourmere's email invitation identity or process
calendar RSVPs. Do not add attendees or scheduling inbox/outbox delivery until duplicate
invitation behavior and provider scheduling side effects have been tested. Preserve
existing Hourmere notification and imported-booking policies.

## Provider notes and sources

Official documentation checked **2026-11-06**. These are documented provider setup
requirements, not completed live-account acceptance. No real provider requests were
made during implementation or tests.

| Provider | Proposed bootstrap and credentials | Limits and uncertainty |
| --- | --- | --- |
| iCloud | Proposed bootstrap `https://caldav.icloud.com/`; Apple Account login with an app-specific password and 2FA. | Apple's app-password guide confirms the authentication requirements, but the official sources checked do not publish a stable generic CalDAV endpoint/discovery SLA. Treat this hostname as an integration assumption pending authorized acceptance, not an Apple API guarantee. Sharded cross-origin discovery is refused unless exact origins have been operator-approved. |
| Fastmail | `https://caldav.fastmail.com/`, full Fastmail username and an app password with calendar access. | Basic plans do not include CalDAV. Regional/account paths and capabilities require discovery; there is no tested Hourmere compatibility claim or published request quota here. |
| Nextcloud | `https://<host>[/installation-prefix]/remote.php/dav/`; dedicated app password recommended and required for the documented 2FA client setup. | Preserve the installation prefix. Correct well-known redirects depend on proxy configuration. Server/app versions, sharing permissions and installed Calendar app matter. Private addresses require operator exceptions; self-signed TLS is rejected unless the operator explicitly trusts its CA through process configuration. |

**Known limitation:** define how iCloud calendar homes
on `pNN-caldav.icloud.com` will be authorized under the exact-origin credential policy.
One candidate is a narrowly scoped, code-defined allowlist of Apple-controlled shard
hosts for connections explicitly identified as iCloud, with tests for lookalike hosts,
redirects and DNS/address validation. Decide the supported host pattern and trust
source before authorizing these cross-origin requests. Do not infer trust from response XML
or enable a generic suffix wildcard. The iCloud preset does not grant any shard exception;
connections that require one fail closed. There is no user-facing bypass.

Apple's [app-specific-password guide](https://support.apple.com/en-us/102654) states that
2FA is required, permits up to 25 active app passwords, and revokes them when the primary
account password changes or is reset. It also describes Apple Account authorization for
supported third-party apps; Hourmere does not implement that alternative and must not
imply app passwords are the only authentication method Apple offers.

Fastmail's [server names and ports](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports)
provides the CalDAV endpoint, TLS and app-password requirements and plan exclusion.
Its [manual calendar setup](https://www.fastmail.help/hc/en-us/articles/360058752934-Manual-setup-of-Calendar-on-Mac)
provides principal-path examples. Use discovery, not those examples as hard-coded
account identifiers.

Nextcloud's [service discovery guidance](https://docs.nextcloud.com/server/stable/admin_manual/issues/general_troubleshooting.html#service-discovery)
documents `remote.php/dav` and subdirectory deployments; its
[macOS calendar guide](https://docs.nextcloud.com/server/latest/user_manual/en/groupware/sync_osx.html)
describes app passwords with 2FA. Its [TLS installation guidance](https://docs.nextcloud.com/server/stable/admin_manual/installation/source_installation.html#enabling-ssl)
recommends TLS and discusses self-signed certificates. Hourmere's always-verify policy
above is our security decision, not a claim that Nextcloud forbids self-signed servers.

## Operator note and scope limits

CalDAV uses `CALENDAR_ENCRYPTION_KEY`, with the same functionality on self-hosted
instances and no hosted-service entitlement gate. Plan outbound DNS and verified HTTPS
from every process that runs discovery, sync or writes; do not expose a new inbound port.
Allow PROPFIND/REPORT and PUT/DELETE in the destination reverse proxy. Restrict
network egress at the infrastructure layer as well as the application guard.

For internal Nextcloud, `CALDAV_PRIVATE_TARGETS` supplies narrow private host/port or
private CIDR/port exceptions using the same syntax as `WEBHOOK_PRIVATE_TARGETS`.
The settings are separate: webhook exceptions never authorize CalDAV traffic.
`CALDAV_ALLOWED_ORIGINS` supplies at most 32 comma-separated exact HTTPS origins that
may receive the connection's Basic credentials. No wildcard, userinfo, path, query or
fragment is allowed. Apply both settings consistently to web and worker processes;
they cover discovery, busy reads and writes. An origin exception does not bypass the
address guard, and a private address exception does not authorize cross-origin secrets.
Link-local/metadata destinations remain blocked; exceptions never disable TLS.

Out of scope here: credential entry through API keys/MCP/CLI, live-account
acceptance, client-side recurring expansion,
OAuth, Digest/NTLM/client-certificate login, DNS SRV/TXT discovery, calendar creation,
sharing management, CardDAV, VTODO, attachments, RSVP processing, scheduling delivery,
provider-specific push, and arbitrary self-signed-certificate acceptance. Mock tests
establish behavior against synthetic servers only. Each provider still needs separately
authorized live acceptance before compatibility can be claimed.
