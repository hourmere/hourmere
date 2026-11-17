---
title: Troubleshoot availability
description: See why a time cannot be booked, from the admin, REST, MCP or CLI.
---

When an invitee says “there are no times on Tuesday”, open **Availability → Troubleshoot
availability**. Pick an event type and a day; Hourmere lists every possible start time of
that local day, says which ones can be booked, and gives the reason for each one that
cannot. The same answer is available to agents and scripts through REST, MCP and the CLI.
Troubleshooting reads availability only: it books, reserves or changes nothing.

## Who can use it

- Personal event types: their owner, acting in their personal space.
- Team event types: a current, verified team owner or admin acting in that team.
- API keys need **Full account access** (`full`). `read` and `bookings` keys are refused
  with `insufficient_scope`, because repeated explanations can reveal when someone is busy.
- MCP OAuth connections use the existing `mcp:tools` grant, with the same owner/admin rule.

Everyone else, including ordinary team members, assigned hosts who are not admins and
callers from another organization, gets exactly the same `event_type_not_found` answer as for
an event type that does not exist. The admin page shows this as an access message, never as a
setup problem.

## Use it in the admin

1. Open **Availability** and choose **Troubleshoot availability** (`/app/availability/troubleshoot`).
2. Choose the event type and the day. The time zone defaults to your profile’s; change it to
   read the day as an invitee elsewhere would.
3. Choose **Check this day**.

The event type list offers only the event types you may troubleshoot: your own, and in a team
also the team’s event types when you are a team owner or admin. Ordinary team members see a
note instead of team event types they cannot check. Times that are only outside your available
hours are hidden by default; clear the checkbox to see them. On a day when the clocks change,
times whose UTC offset differs from the start of the day show their zone (for example
“1:00 AM EDT – 1:00 AM EST”), so a repeated hour is never ambiguous. Team event types name the host each reason belongs to. A reason that affects only part
of a time (a buffer, for example) shows the affected range.

## Reasons

Hourmere shows only reasons its scheduling engine actually reports. Several can apply to one time.
The table is in reason priority order: the first returned reason is the first blocking rule,
not necessarily the only problem. Resolve it, then check again. An available time has no
reasons. For ordinary individual slots, with the same saved data, clock, length and range, available
explanations match ordinary slot availability; a later booking attempt still checks availability again.

| Code | Meaning and next step |
| --- | --- |
| `past` | The start has passed. Choose a future time. |
| `duration_not_offered` | The selected length is not offered. Choose a saved allowed duration, or save a change in the event editor. |
| `outside_working_hours` | The whole meeting must fit the host's weekly hours or that date's override. Check the assigned schedule, its zone and overrides; an override replaces weekly hours. |
| `off_slot_grid` | The start is not on the working interval's slot grid. Choose an offered start; changing only the display zone does not change the grid. |
| `minimum_notice` | The start is too soon. Choose a later start or deliberately change and save minimum notice. Notice uses elapsed minutes, so 1440 means exactly 24 hours. |
| `booking_window` | The start is too far ahead. Choose an earlier date or extend the saved window. Its days are calendar days in the host's schedule zone, not fixed 24-hour periods. |
| `calendar_busy` | A calendar selected for conflict checking overlaps the meeting. Check that time privately in the source calendar, move the commitment or choose another slot; wait for successful sync after changing it. |
| `buffer_before` | Free time required before this meeting or around an existing booking causes a conflict. Leave more space or review saved buffer settings for both event types. |
| `buffer_after` | Free time required after this meeting or around an existing booking causes a conflict. Leave more space or review saved buffer settings for both event types. |
| `daily_limit` | This event type has reached its host-local daily booking ceiling. Choose another day, review active bookings or deliberately raise the limit. |
| `weekly_limit` | This event type has reached its host-local Monday–Sunday ceiling. Choose another week or review the limit and active bookings, including days outside this view. |
| `monthly_limit` | This event type has reached its host-local calendar-month ceiling. Choose another month or review the limit and active bookings outside this view. |
| `host_conflict` | Another active Hourmere booking takes the time, possibly in another space or event type. Choose another time or manage that booking with the appropriate permission. |
| `collective_member_unavailable` | Every collective host is required. Read the named hosts' reasons and find a time that works for everyone. |
| `no_eligible_round_robin_host` | No eligible pool member can offer the time. Review pool activation, host eligibility and each host's schedule/calendar readiness. |

Calendar busy blocks do not count toward booking limits. Limits count active bookings for
this event type by their start in each host's schedule zone; cancelled bookings do not count.
See [booking limits](/docs/booking-limits) for rescheduling and team behavior. Buffers on the
candidate and an existing booking add together; the shown affected interval is clipped to
the candidate and may represent a commitment just outside it.

[Duration presets](/docs/multiple-durations) are editor shortcuts. Troubleshooting uses the
saved default length, or an explicit `durationMinutes` through REST/MCP/CLI. Recheck after
saving a preset or other timing settings; an unsaved editor change has no effect.

### Sync freshness and provider differences

`calendar_sync_unavailable` is a request error, not a busy-time reason. For selected Google
and CalDAV conflict calendars, missing, failed, stale (over ten minutes), incompatible or
incomplete cached snapshots cannot establish availability. Coverage must include the queried
range and buffers. Personal and collective checks return this error; round-robin checks
can omit affected hosts and still offer another eligible host. Do not interpret the error
as “no working hours”, “no calendar configured” or “the host is busy”. Check connection
status and synchronization, reconnect if requested, then retry after a successful sync.
The view never fetches providers itself. **Refresh calendar list** alone is not busy sync.

- **Google:** busy synchronization expands recurring instances and exceptions at the
  provider. Cancelled, transparent and self-declined events do not block; tentative opaque
  events do. All-day events use exclusive end dates and expand in the evaluated host's
  schedule zone. Timed events retain their absolute instants, including overnight/DST spans.
- **CalDAV:** internal services now support busy synchronization and booking write-back.
  They consume server-expanded recurring instances and exceptions, exclude transparent and
  cancelled events, and keep tentative events busy. Declined events remain conservatively
  busy because the sync service does not yet supply verified calendar-user addresses.
  Unexpanded recurrence, unsupported custom time zones and ambiguous/nonexistent local DST
  values fail sync unless the server supplies usable expanded values. Connection routes,
  app controls and production worker registration remain unavailable; these services do not
  mean a user can connect iCloud, Fastmail or Nextcloud today.
- **Microsoft:** the shipped connection lists calendars and manages credentials; it does
  **not yet sync busy events or write bookings**. Microsoft calendars also have **no
  sync-freshness check** in availability. An available explanation is not proof that an
  Outlook calendar is free or current. Check Outlook separately until busy sync is shipped.

### Existing bookings and change deadlines

This view diagnoses a **new booking**, not whether an invitee can change an existing one.
It has no booking/manage-token input, does not exclude the booking being moved and does
not return a deadline reason. A time can be available here while an invitee's reschedule
or cancellation is closed. Open the booking's management page to inspect its saved deadlines;
changing today's event settings does not change an existing booking's deadline snapshot.

Invitee rescheduling closes at the earlier of the reschedule and cancel deadline instants;
the exact deadline is already closed. `booking_reschedule_deadline_passed` and
`booking_cancel_deadline_passed` are action errors, not slot reasons. Contact the host after
a deadline; authorized host actions retain their normal permissions. See
[change deadlines](/docs/change-deadlines) for elapsed-time/DST examples and other restrictions.

## Privacy

New codes may be added; clients should show unknown codes neutrally. Reasons never contain
calendar event titles, attendees, locations, calendar or event IDs, or booking details: only the
code, the affected interval and, for team event types, the host’s user ID. The response lists
the team’s assigned hosts with their names.

For team event types, a time outside a host’s working hours (weekly hours or a date override)
reports `outside_working_hours` for that host. Other nonprivate rule reasons may remain.
Their `calendar_busy`, `buffer_before`,
`buffer_after` and `host_conflict` reasons for that time are left out, so team owners and admins
do not see when members are busy outside their working hours. One exception remains: on a time
inside working hours, a `buffer_before` or `buffer_after` reason can show where an adjacent
off-hours commitment begins or ends, within one buffer length of the working hours. For example,
with a 30-minute buffer and a member busy from 12:10 after hours that end at 12:00, the 11:30
time reports `buffer_after` from 11:40 to 12:00. On your own personal event types you still see
every reason.

## REST

```sh
curl -H "Authorization: Bearer $HOURMERE_API_KEY" \
  "$HOURMERE_URL/api/v1/event-types/$EVENT_TYPE_ID/availability-troubleshooting?date=2026-11-16&timeZone=Europe/Berlin"
```

Query parameters: `date` (required, `YYYY-MM-DD`), `timeZone` (IANA; defaults to your profile
time zone, else UTC) and `durationMinutes` (defaults to the event length). The response:

```json
{
  "eventTypeId": "…",
  "date": "2026-11-16",
  "timeZone": "Europe/Berlin",
  "durationMinutes": null,
  "rangeStart": "2026-11-15T23:00:00Z",
  "rangeEnd": "2026-11-16T23:00:00Z",
  "hosts": [],
  "slots": [
    { "start": "2026-11-16T08:00:00Z", "end": "2026-11-16T08:30:00Z", "status": "available", "reasons": [] },
    {
      "start": "2026-11-16T08:30:00Z",
      "end": "2026-11-16T09:00:00Z",
      "status": "unavailable",
      "reasons": [{ "code": "calendar_busy", "start": "2026-11-16T08:30:00Z", "end": "2026-11-16T09:00:00Z" }]
    }
  ]
}
```

Errors: `400 invalid_date`, `invalid_time_zone`, `invalid_duration`, `range_too_long`;
`403 insufficient_scope`; `404 event_type_not_found`; `409 calendar_sync_unavailable` when
selected Google/CalDAV snapshots fail freshness or coverage checks, or `409 location_unavailable` when the event’s
default location cannot be offered.

## MCP

Call `troubleshoot_availability` with `{ "eventTypeId": "…", "date": "2026-11-16" }` and
optional `timeZone` and `durationMinutes`. `structuredContent` is the same object as the REST
response. Ask an agent, for example: “Why can nobody book my intro call next Tuesday?”

## CLI

```sh
echo '{"eventTypeId":"…","date":"2026-11-16","timeZone":"Europe/Berlin"}' |
  hourmere troubleshoot-availability --input -
```

The CLI prints the same JSON. It needs a `full` key.

## Known limitations

- One local day per request. A DST change day has 23 or 25 hours; start times that do not
  exist locally are skipped and repeated ones use their first occurrence, like ordinary
  availability.
- Explanations use cached data and do not reserve a time. Provider polling can lag a new
  external event even when the snapshot passes freshness checks. Recheck before booking;
  there is no atomic transaction shared with an external calendar.
- Google/CalDAV freshness checks do not cover Microsoft. CalDAV services remain internal,
  and Microsoft busy synchronization remains unavailable, as described above.
- `outside_working_hours` does not say whether weekly hours or a date override closed the time;
  check both on the schedule.
- For a team host, a time even partly outside their working hours hides that host's
  busy, buffer and booking-conflict reasons, even if a busy block also falls inside their
  hours. Other nonprivate reasons remain.
- This view does not diagnose admission to an existing group session or its remaining seats;
  use the ordinary group booking page for seat availability.
- The admin page explains the event’s default meeting length and default location. Use REST,
  MCP or the CLI with `durationMinutes` for another offered length.
- Event types with a very fine slot step over many hosts can exceed the candidate budget and
  return `range_too_long`.

## 中文使用说明

打开 **可用时间 → 排查可预约时间**，选择事件类型、日期和显示时区，再检查当天。
仅个人事件的所有者或团队所有者/管理员可用；API 密钥必须为 `full`，MCP OAuth
须有 `mcp:tools` 授权且满足同样的角色要求。`read`/`bookings` 密钥返回
`insufficient_scope`；无管理权限与不存在的事件均返回 `event_type_not_found`。
这不是配置缺失提示。检查只读，不预留或创建预约。

原因按上表顺序排列，第一项是首个阻止预约的规则，后面可能还有其他原因。
同一已保存配置、数据库快照、当前时间、时长和范围下，`available` 且原因为空
与普通单人时段计算一致；修改后应重新检查。已有团体场次的入场和剩余座位不在此诊断范围内，
请在团体预约页检查。

- `past`：开始时间已过，选择未来时间。
- `duration_not_offered`：该时长未开放，选择已保存的允许时长。预设只是编辑快捷方式，须保存才生效。
- `outside_working_hours`：整场会议不能放入工作时段；核对所用日程、时区及日期覆盖，日期覆盖会替换周规则。
- `off_slot_grid`：不在工作区间起点对应的开始时间网格上，请选实际提供的时间。
- `minimum_notice`：提前量不足；选择更晚的时间或修改并保存设置。1440 分钟始终是经过的 24 小时。
- `booking_window`：超出可预约窗口；改选较近日期或延长窗口。天数按主持人的日程时区计算日历日。
- `calendar_busy`：已选冲突日历有重叠；在原日历私下核对，改选时间或移动事件后等待同步成功。
- `buffer_before` / `buffer_after`：当前会议或已有预约的前后缓冲发生冲突；留出更多间隔，核对双方事件类型的缓冲设置。
- `daily_limit` / `weekly_limit` / `monthly_limit`：达到此事件类型的日、周或月上限；换周期、核对有效预约或调整上限。周为周一至周日，月为日历月，均按主持人日程时区的开始日期计数。日历忙碌不计入上限。
- `host_conflict`：其他有效 Hourmere 预约占用时间，可能来自其他空间；换时间或由有权限的人处理原预约。
- `collective_member_unavailable`：集体会议需要所有主持人空闲，请查看各人的原因。
- `no_eligible_round_robin_host`：没有符合条件且空闲的轮值主持人；核对池的启用、资格、日程及日历状态。

`calendar_sync_unavailable` 是整个请求的错误，不是忙碌原因。Google 和内部 CalDAV
冲突日历的快照缺失、失败、超过十分钟、版本不兼容或未覆盖查询及缓冲范围时，不能
判断为空闲。个人及集体检查返回错误；轮值可跳过受影响的人而由其他人提供时间。
检查连接状态、按提示重新连接并等待同步成功；只刷新日历列表不能代替忙碌同步。
未知状态不能说成未设置工作时间、未连接日历或确定忙碌。

Google 使用服务器展开的重复事件与例外；取消、透明和本人已拒绝的事件不阻塞，
不透明的暂定事件会阻塞。全天事件按主持人日程时区从开始日午夜到排他结束日午夜
展开；跨午夜、跨夏令时的定时事件保持绝对时间。CalDAV 已有内部忙碌同步及写回服务，
支持服务器展开的重复实例与例外，但连接界面、公开接口及生产任务注册尚未开放。
CalDAV 排除透明和取消事件，保留暂定事件；当前同步服务没有提供已验证的日历用户
地址，因此拒绝的事件仍保守地计为忙碌。不支持的重复规则或本地 DST 时间会令同步失败。
Microsoft 当前仅连接、列出日历和管理凭据，没有忙碌同步、写回，**也没有同步新鲜度检查**；
这里显示可预约不能证明 Outlook 空闲或数据新鲜。

这是新预约排障，不是已有预约的改期资格检查：不会排除正在改期的原预约，也不会显示
截止时间原因。请在原预约管理页查看其保存的截止时间；后来修改事件设置不会改变它。
受邀者改期在改期和取消截止时刻中较早者关闭，到达该时刻即拒绝。动作错误为
`booking_reschedule_deadline_passed` 或 `booking_cancel_deadline_passed`，请联系主持人。

隐私：仅返回原因、裁剪到候选时段内的影响区间，团队还包含主持人 ID 和姓名；不返回
日历事件标题、参会者、地点、日历/事件 ID、预约详情。团队成员工作时间外的忙碌及缓冲
原因会隐藏；但工作时间内的缓冲提示仍可能透露相邻非工作时间承诺的边缘。
因此不能把诊断接口公开给受邀者。

限制：每次一天，夏令时切换日可能是 23 或 25 小时；不存在的本地开始时间跳过，重复
时间采用第一次出现，时长按经过的分钟计算。显示时区不改变主持人的日程规则。
页面检查默认时长及默认地点；其他已开放时长用 REST/MCP/CLI 的 `durationMinutes`。
快照与现实日历可能有同步延迟，结果不预留时间。过细网格和过多主持人可能返回
`range_too_long`；权限、加载和同步错误均应保持中性提示，不能当成配置缺失。
