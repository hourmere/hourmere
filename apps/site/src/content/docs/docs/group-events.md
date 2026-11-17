---
title: Group events
description: Offer several independent seats at one single-host meeting and privately review its attendee list.
---

A group event lets several invitees book the same meeting with one host. Each invitee
books one seat, receives their own confirmation and management link, and keeps their
answers private. Group events are included in self-hosted installations without a plan gate.

## Set up a group event

Open **Event types**, create or edit an individual event type, select group booking mode,
and enter a capacity of **2–100**. Disable guests and save. Personal owners and team
owners/admins use the same editor. A group event has one host; collective and round-robin
events cannot use group mode. An occurrence has one shared location: invitee-supplied
phone locations are unsupported, and the editor does not let a group event offer
additional location choices, because seats always use the default location.

Existing future confirmed bookings or pending payment holds prevent changing booking
mode. Cancel or complete that booked work first, or create a separate event type.
Changing capacity applies to new occurrences; it does not resize an existing occurrence.
Saving an event does not bypass its ordinary availability, host or conference requirements.

## What invitees see

Public booking pages and embeds show remaining seats beside available group times.
Full occurrences are omitted. Counts are a snapshot, not a reservation: confirmation
checks capacity again. If the last seat is taken, the page asks the invitee to choose
another time and retains their form entries. A full or otherwise unusable occurrence
gives the same refusal to an existing seat holder and a new visitor.

Every seat is a separate booking. An invitee can cancel or move only their own seat
using their private management link. Other attendees' names, email addresses, answers
and attendance markers are never included in that response. The public slots API exposes
only aggregate `capacity` and `seatsRemaining`, without attendee or seat identities.

## Review the attendee list

In **Bookings**, open a group booking's detail to review the occurrence's seat holders,
including names, email addresses, answers, booking status and no-show state. Cancelled
seats remain visible as history and no longer consume capacity. Each booking row represents
one seat; `groupSlotId` associates authorized booking reads with their occurrence.

The host can read the list in the dashboard, REST, MCP and CLI. Current team owners/admins
who are not the host can read it through a browser session in that team. As with other
booking reads, API keys and MCP OAuth grant access only to the caller's hosted bookings
in the current organization. Ordinary non-host members, other organizations and invitee
management tokens grant no access. Missing and unauthorized occurrences receive the same denial.

Cancelling one booking cancels only that seat. Cancelling the whole occurrence cancels
all its active seats and prevents booking that occurrence again. Review the entire
occurrence before choosing that action. Existing per-seat cancellation and rescheduling
keep other seats and their shared calendar/conference resources intact.

## REST, MCP and CLI

Create with `POST /api/v1/event-types`, MCP `create_event_type`, or CLI `create-event`:

```json
{
  "slug": "workshop",
  "title": "Workshop",
  "durationMinutes": 60,
  "bookingMode": "group",
  "groupCapacity": 12,
  "allowGuests": false
}
```

Update with `PATCH /api/v1/event-types/{id}`, MCP `update_event_type`, or CLI
`update-event`. MCP and CLI take `id` beside the changed fields. Omitted update fields
preserve saved settings. Individual mode uses `bookingMode: "individual"` and
`groupCapacity: null`. Configuration requires a `full` API key and ordinary event-management
permission. Event reads include both fields.

| Action | REST | MCP | CLI |
|---|---|---|---|
| Read occurrence attendees | `GET /api/v1/group-occurrences/{id}/attendees` | `get_group_occurrence_attendees` | `group-attendees` |
| Cancel occurrence | `POST /api/v1/group-occurrences/{id}/cancel` | `cancel_group_occurrence` | `cancel-group` |

Attendee reads allow `read`, `bookings` and `full` keys; cancellation allows `bookings`
and `full`. MCP OAuth retains the `mcp:tools` grant and the same host boundary.
Use `hourmere group-attendees --input occurrence.json` with JSON
`{"occurrenceId":"<groupSlotId from an authorized booking>"}`. For `cancel-group`,
use the same identifier and optional `reason`. REST cancellation accepts optional
`reason` in its JSON body. Repeating whole-occurrence cancellation rechecks authority
and returns `cancelledSeatCount: 0` without sending more notifications. Keep returned attendee data private.

## Limitations

- One host and one seat per invitee booking; no guests, collective or round-robin groups,
  multiple-seat purchases or group payment checkout.
- Capacity, location, schedule and conference settings are snapshotted for each occurrence.
  Edits govern new occurrences. Existing occurrences retain their shared settings and
  keep accepting seats subject to current activation, booking cutoffs, allowed duration
  and usable pinned conference resources.
- Later time off, external-calendar conflicts and stale calendar sync do not block
  additional seats in an existing occurrence. Cancel the occurrence to stop admission.
  New occurrences check current availability and calendar freshness.
- The invitee reschedule picker lists new available occurrences only; it does not show
  remaining seats or offer other occupied group occurrences. Moving or cancelling a
  seat still updates public remaining-seat counts.
- A no-show mark does not release a seat or notify attendees. Requests asking invitees
  to choose another time are unavailable for group seats.
- Daily, weekly and monthly booking limits count occupied occurrences, not seats.
  When the last seat is cancelled normally, a later booking may create a new occurrence;
  explicit whole-occurrence cancellation keeps that exact interval closed.

## 中文说明

在“事件类型”中选择群组预约并设置 2–100 个座位。群组仅支持一位主持人，
不支持携带来宾、集体或轮询主持、一次购买多个座位及群组付款。
已有未来有效预约或待付款预约时不能切换模式；容量修改仅影响新场次。

公开页面只显示剩余座位，满员场次不再提供。每位受邀人有独立预约、答案和管理链接，
无法通过这些链接查看其他参会者。主持人可在预约详情、REST、MCP 和 CLI 中查看名单；
非主持人的团队所有者和管理员须使用当前团队的浏览器会话。API 密钥和 OAuth 仍限本人主持的场次。
名单包含姓名、邮箱、答案、预约状态及缺席标记，也保留已取消座位。
取消一个座位只影响该预约；取消整场会取消全部有效座位并关闭该场次。
