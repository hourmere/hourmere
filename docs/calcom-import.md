# Cal.com / cal.diy import operator draft

This first slice **only extracts and parses in memory**. Nothing is imported into Hourmere.
It has no target database connection, apply command, provider calls or preview UI.
Supported source versions are cal.diy `a5ee96f77edd644439e7de8c3255ccb2eb2c5941`
and Cal.com `v6.2.0` (`1c193cca8682b33b9866c792186033f7ef886682`).
An unrecognized scalar, enum or relationship signature is refused. The operator-supplied
version and actual schema fingerprint are retained separately. Do not relabel older databases.

Future accepted personal bookings are candidates for **local-only, read-only busy records**.
They remain managed in the old system. They must never create emails, ICS, management links,
calendar copies, meetings or webhooks. This slice creates none of those records.
All event proposals remain inactive drafts; hidden controls listing visibility separately.
Teams, organizations, managed/multiple-host events, payment and instant features are excluded
or blocked. The structured report lists each detected loss and includes every out-of-scope
category without reading forbidden tables just to count them.

## Prepare a dedicated SELECT-only source role

A source database administrator performs this setup outside the importer. The importer never
creates roles, grants permissions or changes the source. Use a dedicated account that owns
neither the database nor any application relation, has no role memberships or inheritance,
and has no application write privileges or access to other application columns. Revoke
inherited PUBLIC write privileges as necessary, including PUBLIC temporary-table creation.
These PUBLIC changes affect other roles: review the source deployment's grants first and
restore required access to its normal application role explicitly.

In an administrator psql session, replace `source_database` with the controlled source name.
Set the password interactively; never put it in command arguments or shell history.

```sql
CREATE ROLE hourmere_import LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
\password hourmere_import
REVOKE CREATE, TEMPORARY ON DATABASE source_database FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE source_database TO hourmere_import;
GRANT USAGE ON SCHEMA public TO hourmere_import;
ALTER ROLE hourmere_import SET default_transaction_read_only = on;
GRANT SELECT ("id", "email", "emailVerified", "username", "name", "timeZone", "locale", "defaultScheduleId", "organizationId", "movedToProfileId", "bufferTime") ON public."users" TO hourmere_import;
GRANT SELECT ("id", "userId", "organizationId", "username") ON public."Profile" TO hourmere_import;
GRANT SELECT ("id", "userId", "teamId", "profileId", "parentId", "title", "slug", "length", "description", "position", "locations", "bookingFields", "timeZone", "periodType", "periodStartDate", "periodEndDate", "periodDays", "periodCountCalendarDays", "minimumBookingNotice", "beforeEventBuffer", "afterEventBuffer", "hidden", "slotInterval", "offsetStart", "scheduleId", "schedulingType", "disableGuests", "requiresConfirmation", "requiresConfirmationWillBlockSlot", "requiresConfirmationForFreeEmail", "requiresBookerEmailVerification", "bookingRequiresAuthentication", "recurringEvent", "seatsPerTimeSlot", "disableCancelling", "disableRescheduling", "minimumRescheduleNotice", "useBookerTimezone", "restrictionScheduleId", "enablePerHostLocations", "maxActiveBookingsPerBooker", "bookingLimits", "durationLimits", "createdAt", "updatedAt", "price", "isInstantEvent", "assignAllTeamMembers", "assignRRMembersUsingSegment", "rrHostSubsetEnabled", "metadata") ON public."EventType" TO hourmere_import;
GRANT SELECT ("id", "eventTypeId", "label", "type", "options", "required", "placeholder") ON public."EventTypeCustomInput" TO hourmere_import;
GRANT SELECT ("eventTypeId", "userId", "scheduleId", "groupId", "memberId") ON public."Host" TO hourmere_import;
GRANT SELECT ("id", "userId", "name", "timeZone") ON public."Schedule" TO hourmere_import;
GRANT SELECT ("id", "userId", "eventTypeId", "scheduleId", "days", "startTime", "endTime", "date") ON public."Availability" TO hourmere_import;
GRANT SELECT ("id", "userId", "eventTypeId", "title", "startTime", "endTime", "status", "location", "responses", "customInputs", "createdAt", "updatedAt", "rescheduled", "recurringEventId", "paid", "description", "dynamicEventSlugRef", "dynamicGroupSlugRef", "uid", "fromReschedule") ON public."Booking" TO hourmere_import;
GRANT SELECT ("bookingId") ON public."BookingSeat" TO hourmere_import;
GRANT SELECT ("id", "bookingId", "name", "email", "timeZone", "locale") ON public."Attendee" TO hourmere_import;
GRANT SELECT ("id") ON public."Team" TO hourmere_import;
GRANT SELECT ("teamId", "userId") ON public."Membership" TO hourmere_import;
GRANT SELECT ("userId", "startDate", "endDate") ON public."TravelSchedule" TO hourmere_import;
GRANT SELECT ("userId", "start", "end") ON public."OutOfOfficeEntry" TO hourmere_import;
GRANT SELECT ("userId", "countryCode") ON public."UserHolidaySettings" TO hourmere_import;
GRANT SELECT ("id", "eventTypeId") ON public."HostGroup" TO hourmere_import;
GRANT SELECT ("userId", "eventTypeId") ON public."HostLocation" TO hourmere_import;
GRANT SELECT ("A", "B") ON public."_user_eventtype" TO hourmere_import;
GRANT SELECT ("bookingId", "type", "deleted", "meetingUrl") ON public."BookingReference" TO hourmere_import;
GRANT SELECT ("bookingId") ON public."Payment" TO hourmere_import;
```

`metadata` privileges are necessary for audited JSON-path projections. The importer never
returns full metadata. Booking `uid` and `fromReschedule` privileges are used only in the
fixed lineage comparison; neither capability is returned. Payment and seat tables are
checked only for association existence. Booking references are extracted only for unresolved
eligible booking locations and use only the audited minimum columns. No credential,
password, session, MFA, payment payload, provider event ID or host administration link is read.
Empty calendar reference URLs are ignored when resolving an existing video meeting; unsafe
nonempty URLs still block the booking, including after their contents have been redacted.

Booking text, answers and locations are read only for strictly future accepted bookings whose
current event relationships prove personal, single-host scope. Future pending/awaiting-host
and out-of-scope bookings retain only the identifiers, status and times needed to report their
blockers. Attendees and location references are read only for the personal accepted candidates.
Past/already-started rows and future cancelled/rejected rows are counted in SQL by matched
owner; their payloads are not transferred. `bookingExclusionCounts` reports `pastOrStarted`
and `terminal` separately, and `summary.excludedBookings` totals those excluded source rows.
`summary.excluded` continues to count structured exclusion problem entries. Reschedule
successor dependencies carry only identifiers, status, times and derived lineage flags;
they are not separate busy-record candidates. Raw booking capabilities never leave SQL.

The extractor uses one connection (`max=1`), a `REPEATABLE READ READ ONLY` transaction,
`SET LOCAL timezone='UTC'`, a fixed catalog search path, 15-second statement,
2-second lock and 15-second idle-transaction limits. It verifies the actual transaction
read-only/isolation/timezone settings. All data queries are fixed, parameterized,
public-schema-qualified and bounded. Extraction commits and closes before parsing;
failures roll back and close. Row/byte caps fail the entire extraction without partial output.

## Protected inputs

Use owner-only regular files (mode `0600`), outside the repository. Symlinks, group/world
permissions and oversized files are refused. Keep the source DSN in a separate protected file,
or set `CALCOM_IMPORT_SOURCE_URL` through your existing secret manager. Choose exactly one.
Neither the DSN nor credentials belong in argv, logs, reports, commits or the plan.
Do not use automatically discovered databases or an untrusted connection URL.

The protected JSON configuration has this shape (all identities are examples):

```json
{
  "sourceVersion": "cal.diy-a5ee96f77edd",
  "selectedUserIds": [1],
  "utcTimestampsConfirmed": true,
  "sourceConnectionFile": "/private/calcom-source-connection",
  "target": {
    "users": [{
      "id": "019a4321-1234-7000-8000-000000000001",
      "email": "owner@example.com",
      "emailVerified": true,
      "personalOrganizationId": "019a4321-1234-7000-8000-000000000002",
      "authorized": true,
      "profile": {"handle": "owner", "timeZone": "UTC", "locale": "en"}
    }],
    "occupiedHandles": ["owner"],
    "occupiedSlugs": [],
    "busy": []
  },
  "bookingDecisions": [{
    "sourceBookingId": 10,
    "sourceUserId": 1,
    "singleHostAndAttendeeRolesConfirmed": true
  }]
}
```

`utcTimestampsConfirmed` confirms the source deployment uses UTC semantics for timestamp
without time zone; setting a session timezone cannot establish that historical convention.
`target` is an operator-supplied read-only snapshot, **not a target database verification**.
Supply all normalized identity matches (including duplicates), occupied handles and relevant
organization slugs, and existing host busy intervals (`targetUserId`, `start`, `end` as UTC
ISO instants). Do not treat an unavailable target lookup as an empty array. A later preview
must read and authorize target state again before any apply. `authorized` records the owner's
explicit migration choice; database administrator access does not imply account authorization.
Existing target profiles and display names are preserved. Omit `profile` only when none exists.

Only trim+lowercase email matching is allowed, with both accounts verified, a unique match
and an existing personal organization. Unmatched users' dependency rows are not extracted.
Before confirming each booking, its source owner must verify the historical single host and
attendee roles; the current event owner cannot prove historical ownership. Old bookings
without `responses.email` also require `bookerAttendeeId`. Never choose the first attendee.
Optional `acceptMissingLocation` and `recurringOccurrencesComplete` record explicit source
owner decisions, and default to false. They cannot override invalid data or unsafe links.

```sh
npm run dry-run --workspace @hourmere/import-calcom -- --config /private/import.json
# Simplified Chinese operator status messages; structured problem messages remain English.
npm run dry-run --workspace @hourmere/import-calcom -- --config /private/import.json --lang zh-CN
```

Exit status: `0` means parsing completed without import blockers, `2` means the plan contains
import blockers, `1` means extraction/configuration was refused or failed. Every outcome
means **nothing was imported**. The CLI prints summary counts and safe problems only.
Refusals include a stable code such as `[SOURCE_LIMIT_EXCEEDED]` or
`[SOURCE_EXTRACTION_FAILED]`; configuration failures use `[IMPORT_REFUSED]`.
It never serializes the private in-memory plan, attendee addresses, answers or join links.
Problem entries have a stable code, severity, source table/id and static English message.
`activation_blocker` allows an inactive draft proposal; `import_blocker` prevents a future
user batch from being applied. `excluded` is not a successful import count. Overlapping
source/target bookings are reported as blockers; buffers and daily-limit effects require
later preview review.

Operational caps are 25 selected users, 10,000 rows per table, 50,000 total rows, 1 MB per
row/JSON input and 32 MiB per snapshot. These caps cover transferred candidates, minimal
future blocker rows and lineage dependencies, rather than the count of historical/terminal
exclusions. A single owner's history can exceed 10,000 bookings without consuming candidate
capacity. An oversized future selection still requires fewer selected users, fewer future
candidates in the source, or resolution of oversized input; no candidate is silently dropped.
Target field limits include 20 questions, 50 options, 12 durations, one booker plus ten
guests, and the normal Hourmere text/timezone bounds. No silent truncation or partial batches.
Fingerprints and all in-memory data are private migration data; they are not execution
credentials. Stable question crosswalks are provided for later association persistence.
Persistent source namespaces, authoritative target reads, difference preview, idempotent
atomic apply, persistent local-only guards and the failure-report UI belong to later work.

## 中文操作说明

本阶段仅以只读事务提取源数据，并在内存中解析、校验；**不会向 Hourmere 写入任何数据**。
请使用专用、无继承和提权权限的只读账号，并由源数据库管理员在导入器之外配置上述最小列权限。
源连接凭据和 JSON 配置应保存在仓库之外、权限为 `0600` 的普通文件中；不接受符号链接。
不得将连接凭据放入命令参数、日志或提交记录。

必须确认源库无时区时间戳采用 UTC 约定。目标身份、占用名称及忙碌时段来自操作者提供的快照，
不代表导入器已实时核验目标数据库；无法查询时不可填写空列表冒充无冲突。每位目标所有者须明确授权，
每项历史预约还须由源所有者确认原始单主持和参加者角色。仅匹配两端已验证且唯一对应的现有个人账号。

所有事件均为停用草稿。未来已接受预约仅拟作本地只读忙碌记录，继续由旧系统管理；不发送邮件、
不生成 ICS、不写日历、不创建会议、不触发 Webhook。私密地点不得擅自公开。结构化问题消息使用英语，
包含稳定代码及源表和编号，不包含参加者邮箱或连接秘密。退出码 `0` 表示解析完成且无导入阻断，
`2` 表示存在导入阻断，`1` 表示配置或提取被拒绝或失败；以上均未导入数据。
