---
title: Manage event types
description: Create and edit event types, choose meeting lengths and locations, and manage booking links.
---

## Create with the essentials

Open **Event types → New event type**. The first screen contains **Title**, **Booking
link**, **Duration (minutes)** and **Where the meeting happens**. The initial duration is
30 minutes. The suggested booking link follows your title and duration until you edit
the link yourself. Choose a 15, 30, 45 or 60-minute preset, or **Custom duration** to enter
1–1440 whole minutes. A location may be left unset; a phone, address or meeting link needs
the details requested for that choice.

Choose **Create event type** without opening the other sections to use the defaults:
your default schedule, zero minimum notice and buffers, no booking-window or booking-count
limit, and no invitee change deadlines. The event starts active and listed. Creating an
event does not create working hours or connect a calendar. With an empty account, set your
availability before expecting bookable times; calendar connections are optional.

The remaining settings start folded: **Additional durations**, **Description and visibility**,
**Location options and conferencing**, **Booking waitlist**, **Reminders and follow-ups**,
**Booking form**, **After booking**, and **When people can book**. Team events also have
host and scheduling controls and initially select you as the host. Open a section only
when you need its settings. The same controls are available on phones and desktop, in
English and Simplified Chinese.

中文：进入“事件类型 → 新建事件类型”，首屏只需检查标题、预约链接、时长（分钟）和会议地点。
默认时长为 30 分钟，可选 15、30、45、60 分钟预设或自定义 1–1440 整分钟；地点可留空。
预约链接会随标题和时长生成，手动编辑后不再自动改动。其余设置默认折叠，直接创建会使用默认
时间表、零提前预约时间和前后缓冲、不限制预约窗口与预约数量、不设置受邀人改期或取消截止。
新事件默认启用且列出；创建事件不会创建工作时间。空账号需另设可用时间，连接日历不是必需条件。

## Edit and save

Choose the event title or **Edit** in the list. Sections with saved non-default values
open automatically. Closing a section keeps its values; a validation error opens the
relevant section and focuses the affected field. Saving an untouched form reports that
there are no changes and sends no update. Changing only a timing unit also leaves the
form unchanged. For actual edits, save before sharing: **View and share** uses the saved
booking link, not an unsaved address.

Under **When people can book**, minimum notice means how far ahead a meeting must be
booked; the booking window limits how far into the future invitees can book. Notice and
buffers allow **Minutes**, **Hours** or **Days**. On opening the editor, a positive stored
minute value divisible by 1440 displays in days; otherwise a positive multiple of 60
uses hours; every other value, including zero, uses minutes. Thus 1440 → 1 day,
120 → 2 hours, and 90 → 90 minutes. Booking windows always open in days. Display-unit
choices are not saved. Hints describe the current draft's equivalent, not a previously
saved value. See [timing ranges and calendar-day rules](/docs#notice-booking-window-and-buffers).

**Additional durations** offers 15, 30, 45, 60 and 90-minute add buttons. Duration labels
in the list and offered-length controls split minutes into days, hours and minutes, omitting
zero parts: 90 minutes appears as `1 h 30 min`, unlike a timing input's initial `90` minutes.
The first-screen default preset replaces a sole length; with several lengths it selects
that default and adds it if absent. At 12 lengths, remove one before adding another;
already-offered default presets remain selectable. See [multiple meeting lengths](/docs/multiple-durations).

Open **Location options and conferencing** to offer up to five distinct location kinds,
set their order and default, or enable automatic conferences. Invitees choose a location
before booking; changing the event later does not change a booking's saved choice.
See [meeting location choices](/docs/location-choices). Reschedule and cancel deadline
inputs remain in whole minutes; each booking keeps its original deadlines. See
[change deadlines](/docs/change-deadlines), including the earlier effective reschedule cutoff.

中文：在列表点标题或“编辑”，已保存且非默认的设置组会自动展开。收起不会清空数据，校验失败
会展开出错组并聚焦字段。未修改时保存会提示无需保存，不发送更新；只切换时间单位也不算修改。
保存后用“查看与分享”复制已保存链接。提前预约时间和缓冲值打开时，正数能被 1440 整除则显示天，
否则能被 60 整除则显示小时，其余（含零）显示分钟；预约窗口始终先显示天。单位选择不保存，
提示中的等值是当前草稿。列表和时长选项则按天、小时、分钟组合显示，例如 90 分钟显示为
“1小时 30分钟”。附加时长可快捷添加 15、30、45、60、90 分钟；满 12 项需先移除一项，
已有时长仍可设为默认。地点选项可设置最多五种不同类型、顺序和默认项；已有预约保留原地点和截止时间。

## Start with your connected meeting service

The new event form selects **Google Meet** when you have an active Google Calendar
connection authorized for synchronization. Otherwise, it selects **Zoom** when you have
an active Zoom connection authorized for meetings. If both are connected, Google Meet
takes precedence. With neither, the location stays unset. You can change this choice
before saving; a late connection response does not overwrite your selection.

This selects a meeting-service label only. Automatic meeting creation remains a separate
opt-in with its existing account, destination-calendar and host requirements. A connected
Google account alone does not establish that its calendar supports Meet. See
[automatic Google Meet](/docs/automatic-google-meet) and
[automatic Zoom](/docs/automatic-zoom) before enabling automatic links.

These defaults apply only to the new web form. Existing event types and REST, MCP and
CLI creation defaults stay unchanged. If connection information cannot be loaded, the
form keeps its ordinary default without claiming that an account is missing.

中文：新建表单优先选择已连接且获同步授权的 Google Meet；否则选择已连接且获会议授权的
Zoom。两者都有时优先 Meet，都没有时不设地点。此默认值只选择服务名称，不自动开启会议链接
生成，也不会修改已有事件或 REST、MCP、CLI 的默认行为。

## Manage the list

Each event row has an enable/disable switch. Disabled rows are visually muted and retain
a readable status. Disabling stops new bookings; it does not cancel existing bookings.
If saving fails, the switch returns to its previous state and reports the error.

Open **More** for **Duplicate**, **Embed** or **Delete**. Delete asks for confirmation
before removing the event from the list; choose **Cancel** to keep it. Deletion stops new
bookings through that link, but does not cancel existing bookings or erase their history.
Embed opens the existing sharing controls and follows the event's current readiness rules.
The controls support keyboard navigation and screen readers.

中文：列表开关可直接启停事件；停用不取消已有预约，保存失败会还原开关并显示错误。
更多菜单提供复制、嵌入和删除；删除必须先确认，也可取消。删除停止此链接的新预约，但不取消
已有预约或删除其历史。

## Duplicate an event type

Choose **More → Duplicate** to create a separate event type in the same space. The
copy retains the title and gets a new booking slug: `introduction-copy`, then
`introduction-copy-2`, and so on. Long slugs are shortened to fit the 64-character limit.
Concurrent duplicate requests receive distinct slugs.

The copy includes the editable description, durations, timing rules, booking limits,
change deadlines, locations, questions, notifications, waitlist settings, visibility,
enabled state, guests, SMS reminder setting, ordering, hosts, schedule and conference
configuration, and after-booking redirect. Review these settings before sharing the link.
Round-robin activation and assignment statistics start fresh; explicitly activate the
new pool when ready. Bookings, attendance/history/statistics, waitlist entries,
one-time links and generated meeting links are not copied.

Personal owners can duplicate their events. Team copies require the same current
owner/admin permission as creating an event in that team. A copy cannot be moved to
another space or another owner through this operation.

| Interface | Operation |
| --- | --- |
| REST | `POST /api/v1/event-types/{id}/duplicate` with `{}`; returns the new event with HTTP 201 |
| MCP | `duplicate_event_type` with `{ "id": "EVENT_TYPE_UUID" }` |
| CLI | `hourmere duplicate-event --input duplicate.json` with the same MCP JSON |

API keys require `full` scope; existing organization and transport permissions still
apply. Browser writes include the current `x-expected-organization-id` header.
The operation is not idempotent: if the response is lost, inspect the event list before
retrying, because a successful retry creates another copy.

中文：复制保留可编辑设置和标题，在同一空间创建带独立链接的新事件；不会复制预约、历史、
统计、候补名单成员或一次性链接。团队事件仅所有者和管理员可复制。轮询池需重新明确启用。
REST、MCP、CLI 同时支持复制，API 密钥需要 `full` 权限。重复调用会新建副本；响应丢失时
请先查看事件列表再决定是否重试。

## REST, MCP and CLI configuration

Creation requires `slug`, `title` and `durationMinutes` on all three interfaces. Unlike the
web form, they do not suggest a slug or select a connected meeting service. Omitted location
configuration leaves the location unset. Use `PATCH /api/v1/event-types/{id}`, MCP
`update_event_type`, or CLI `update-event` with `isActive: false` or `true` to disable or
enable an event; MCP and CLI include `id` beside the changed fields. Omitted fields retain
their saved values. Configuration writes require `full` API-key scope and existing
ownership/organization permissions.

Delete uses `DELETE /api/v1/event-types/{id}` (204 on success). REST deletion has no
interactive confirmation; clients must obtain the user's intended action before sending
it. Event-type deletion currently has no MCP tool or CLI command. Use the web confirmation
or REST. Round-robin activation likewise remains a separate web/REST operation.

中文：REST、MCP、CLI 创建均需传 `slug`、`title`、`durationMinutes`，不会自动生成链接或根据
已连接服务选择地点。更新 `isActive` 可启停，省略字段保留原值；API 密钥需 `full` 权限及原有
所有权和空间权限。删除可用网页确认或 REST `DELETE`；REST 本身不弹确认，目前无对应 MCP 工具
或 CLI 命令。轮询池启用也仍是独立的网页／REST 操作。

## Known limitations

- Creating or enabling an event does not guarantee available slots. Working hours,
  calendars and other booking rules still apply. An unavailable readiness check means
  the result is unknown, not that setup is missing.
- Timing units are display preferences only; REST, MCP and CLI continue using whole
  minutes for notice/buffers and whole calendar days for the booking window.
- Copying revalidates settings under current creation rules. Repair stale hosts, schedules
  or disconnected automatic-conference settings before copying.
- Connection discovery is a form convenience, not a meeting-readiness check. Automatic
  links still require explicit configuration and are validated when saved and booked.
- Changing an event type's location does not change a booking's saved location.
- An unset location is stated explicitly on confirmation pages and booking emails;
  invitees are asked to contact the host for meeting details.
- Enabling a round-robin event's list switch does not activate its pool. Pool activation
  remains a separate explicit action in the editor.

These features are included in self-hosted installations without a subscription.
