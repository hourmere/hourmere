---
title: Hand off a departed host's bookings
description: Propose a replacement host, collect private decisions and review the handoff receipt.
---

When a team host leaves, a team owner or admin can propose a new booking with an eligible
replacement host. The original stays confirmed and holds its time while the team collects
consent. A successful handoff cancels the original and creates an independent confirmed booking
with new management links. The team can hand off future confirmed bookings for single-host
team event types that use individual scheduling. Group, collective and round-robin bookings
are excluded, along with imports, recurring bookings, poll-linked bookings, routing form
bookings, bookings with payment history and bookings with a manually supplied meeting link.

Handoff is off by default. For acceptance on a test instance, the operator sets
`DEPARTURE_HANDOFFS_ENABLED=true` on both the web server and any separate worker, then restarts
or recreates them. Configure SMTP for the private offer emails. Keep production off until
acceptance is complete. See [Configuration reference](/docs/configuration#server-and-database).

## Propose and review a handoff

1. In the team space, repair the event type so the intended replacement is its sole host.
   Check the host's working hours and eligible meeting or calendar connection.
2. Create a proposal through the team handoff REST endpoint described below. You can suggest
   another start time, supported duration or location. The proposal reserves no time.
3. Open **Team bookings**, select the original booking and choose **Preview handoff**. Check
   the replacement host, proposed time and location type. The start must fit the event type's
   current slot grid. A conflict or unverified calendar availability blocks confirmation.
4. Use **Refresh handoff** to check approvals. The booker and every distinct guest mailbox must
   accept the same version. One decline closes the version. One unanswered guest keeps it
   blocked through expiry. The deadline is at most 48 hours after issuance and no later than
   the original or proposed start, whichever comes first.
5. When all approvals are recorded and the slot is available, select **Confirm handoff**.
   Hourmere rechecks the exact terms, slot and permissions. If the response is uncertain, use
   **Refresh handoff** to look for the receipt before trying again. **View replacement booking**
   opens the confirmed replacement. For an expired or closed offer, review a fresh version if
   link delivery is still available, or coordinate manual rebooking with the participants.

### Proposal and queue controls

Create, withdraw, resend and run controls use REST. Send requests from the Hourmere origin
in the current verified owner or admin browser session. Send `X-Expected-Organization-Id`
with the active team's ID. Use session authentication for these actions.

| Action | Method and path | Request |
| --- | --- | --- |
| Create a proposal | `POST /api/v1/team/bookings/{id}/handoff-offers` | `departingUserId` and optional `start`, `durationMinutes` and `locationOptionId`. Add `previous` with `offerId` and `version` to create a fresh version. |
| Read recipient and delivery status | `GET /api/v1/team/bookings/{id}/handoff-offers/{offerId}` | Omit `version` for the latest version, or supply it as a query parameter. |
| Resend to one pending recipient | `POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/resend` | `version` and `recipientId`. Send a random UUID as `Idempotency-Key` and reuse it to retry the same request. |
| Withdraw a version | `POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/withdraw` | `version`. |
| Start an automatic run | `POST /api/v1/team/bookings/handoff-runs` | `departingUserId` and a new UUID as `runId`. Reuse that ID to retry the same start. |
| Read a run receipt | `GET /api/v1/team/bookings/handoff-runs/{runId}` | No request body. |
| Control a run | `POST /api/v1/team/bookings/handoff-runs/{runId}/control` | `action` of `pause`, `resume` or `stop`. |

Each normalized mailbox has three sends per original booking across all versions. The first
send and send attempts with uncertain delivery count. When the worker claims a resend, the
previous link stops working. A new version invalidates all old links and approvals. A queued
send unclaimed for 20 minutes can be replaced by a fresh resend request. If delivery runs out
or a participant cannot respond, coordinate rebooking directly with them.

An automatic run starts only when a current owner or admin explicitly requests it after the
host has left. It selects up to ten live, fully approved versions, in earliest-expiry order.
It sends no new offers. The worker attempts one booking at a time with at least ten seconds
between attempts. Each team can have one running or paused run, starts are at least one minute
apart, and a run expires after 30 minutes including pauses. Pause and stop take effect before
the next booking transaction. Resume a paused run from a currently authorized session in the
team. The running queue is bound to the session that started or most recently resumed it. If
that session switches teams or ends, the next due item fails the run with `authorization_lost`.
To continue after terminal failure, open the original team in a current session and start a
new run for the remaining eligible offers after the cooldown. A former host returning to the
team also stops the run. Check the receipt for each booking's outcome. Run receipts are kept
for seven days. Use the single-booking flow or coordinate manual rebooking for any unresolved
bookings.

## Respond to an offer

1. Open your private link from the latest offer email. Review **Current booking** and
   **Proposed booking** for the time, host and location. If you made the booking, you can also
   review the saved answers that the replacement host will receive.
2. Choose **Accept** or **Decline**, then select **Submit decision**. Opening the link alone
   records no decision. Keep the link private because anyone with it can answer for you.
3. Keep the original time on your calendar until you receive a cancellation. If the team
   applies the handoff, use the replacement confirmation. The booker receives the replacement's
   new management link. If your offer link is unavailable, open the latest one sent to you or
   contact the team. A new version requires a new answer from everyone.

## After confirmation

Refresh the receipt to check cancellation and confirmation mail and the provider status.
Mail server acceptance records handover to the mail server. Check the relevant mailbox for
inbox receipt. The two emails can arrive in either order. The original calendar cancellation
uses its saved organizer and UID and increases the sequence. If no saved organizer is
available, the cancellation is text only and invitees may have to remove the event manually.
The replacement invitation has a new UID, starts at sequence zero and belongs to the new booking.

The workers use the original host's pinned provider accounts and calendar destinations to
clean up old Google Calendar, Meet, Outlook, Teams or Zoom items. They use the replacement
host's eligible connections and destinations for new calendar and meeting entries. Cleanup and
meeting setup can be pending, or their outcome can be unverified. Ask the original account owner
to check unresolved cleanup and the replacement host to check an unverified new meeting.
If a calendar connection was removed before the handoff, the owner of that account must delete
any remaining copies in that calendar. The replacement remains confirmed during provider recovery.

Private links become unusable after a decision, withdrawal, supersession or expiry. A decline
closes the version and revokes its remaining links. An hourly worker closes expired versions
and clears recipient mailboxes and delivery rows starting 48 hours after the offer deadline.
Version history, committed receipts and the source-specific hashed send counts follow the
[handoff storage and deletion rules](https://github.com/hourmere/hourmere/blob/main/docs/data-model.md#departure-booking-handoff-storage).

## 中文操作指南

预约交接默认关闭。在测试环境中，运维人员须同时为 Web 服务和独立 worker 设置
`DEPARTURE_HANDOFFS_ENABLED=true`，并重启或重建服务。配置 SMTP 后才能发送私密提议邮件。
生产环境在验收完成前保持关闭。

1. 团队所有者或管理员先修复活动类型，将符合资格的接任者设为唯一主持人。仅支持尚未开始且已确认的
   团队单人模式预约。团体、集体、轮询、导入、重复、关联会议投票、来自路由表单，以及带付款记录或手动会议链接的预约均不支持交接。
2. 使用上表的 REST 接口创建提议。请求须来自同一实例和当前已验证的团队管理会话，并用
   `X-Expected-Organization-Id` 指定当前团队。打开**团队预约**，选择原预约，再点**试算交接**。
   核对接任主持人、时间和地点类型。试算不会占用拟议时段。时段有冲突或日历状态无法核验时，不能确认。
3. 预订人和每个不同邮箱的来宾都要打开各自最新邮件里的私密链接。核对**当前预约**和**拟议预约**，
   选择**接受**或**拒绝**，然后点**提交决定**。预订人还可查看会共享给新主持人的已保存回答。
   仅打开链接不会记录决定。请勿转发私密链接。
4. 在原预约详情中点**刷新交接状态**。必须是同一版本的所有参与者均已同意，且时段仍可用，才能点
   **确认交接**。一人拒绝即关闭该版本，一人未回复就无法交接。关闭或过期的提议不会取消原预约。
   换版会使旧链接和同意失效，每人都须重新回复。每个邮箱对同一原预约跨版本合计最多三次发送，
   包括首发和送达不确定的尝试。worker 开始发送新链接时，旧链接失效。
5. 确认后，原预约取消，系统创建独立的新预约。可点**查看新预约**，并刷新回执查看邮件、旧条目清理
   和新会议准备状态。参与者应以新确认邮件为准，预订人会收到新预约的管理链接。旧日历取消沿用原 UID 和组织者，
   无已保存组织者时只发文字通知。新邀请使用新 UID。两封邮件的到达顺序可能不同。

自动队列由管理员在主持人离队后显式启动，只处理已获全员同意的有效提议。每轮最多十笔，逐笔处理间隔
至少十秒。同一团队同时只能有一轮运行或暂停，新一轮启动间隔至少一分钟，每轮最长三十分钟，包含暂停时间。
暂停或停止在处理下一笔前生效。暂停后可由当前有权限的会话恢复。运行绑定启动或最近一次恢复的会话，
该会话切换团队或结束时，轮到下一笔处理便会因 `authorization_lost` 失败。失败后请在当前团队的有效会话中，
等启动间隔满足后为剩余符合条件的提议开启新一轮。回执保留七天。

旧日历和会议用原主持人的固定账户清理，新条目用接任主持人符合资格的账户创建。结果无法核验时，
请相应账户所有者检查。如果日历连接在交接前已被移除，该账户的所有者必须删除该日历中仍保留的副本。
后台处理期间新预约仍保持确认。提议到期后，后台逐批关闭失效提议，并在截止时间过四十八小时后清理收件邮箱
和投递记录。保留版本、已完成回执及原预约的哈希发送计数。
