---
title: Manage event types
description: Choose a default meeting service, duplicate an event type and manage its booking link.
---

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
before removing the event from the list. Existing bookings keep their event history.
Embed opens the existing sharing controls and follows the event's current readiness rules.
The controls support keyboard navigation and screen readers.

中文：列表开关可直接启停事件；停用不取消已有预约，保存失败会还原开关并显示错误。
更多菜单提供复制、嵌入和删除；删除必须先确认。

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

## Known limitations

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
