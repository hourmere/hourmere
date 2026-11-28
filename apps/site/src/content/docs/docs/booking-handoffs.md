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
2. Open **Team bookings**, select the original booking and choose **Preview handoff**.
   Check the departing host, replacement host, time and location type. When the preview shows
   an available slot and there is no existing proposal, select **Create proposal**.
   If you enter a different start time, Hourmere checks that time when creating the proposal.
   The proposal reserves no time.
3. Use **Refresh handoff** to check the version, deadline, and each booker or guest's
   decision and link delivery status. The deadline is at most 48 hours after issuance
   and no later than the original or proposed start, whichever comes first.
4. Confirm **Resend** beside a recipient whose link can be resent, or confirm **Withdraw**
   to close the whole version. After a decline, expiry or withdrawal, choose **New version**
   to request fresh decisions. You can set a different start for the new version.
5. When the booker and every guest have approved the same version and the slot is available,
   select **Confirm handoff**.
   Hourmere rechecks the exact terms, slot and permissions. If the response is uncertain, use
   **Refresh handoff** to look for the receipt before trying again. **View replacement booking**
   opens the confirmed replacement.

One decline closes the version. One unanswered guest blocks the handoff through expiry.
Each mailbox has three sends per original booking across all versions. The first
send and send attempts with uncertain delivery count. When the worker claims a resend, the
previous link stops working. A new version invalidates all old links and approvals. A queued
send unclaimed for 20 minutes can be replaced by a fresh resend request. If delivery runs out
or a participant cannot respond, coordinate rebooking directly with them.

### Run automatic handoff after a departure

After removing the host from **Team members**, use **Automatic handoff** in the departure
review. You can also open an affected booking and select **Manage automatic handoff**.
Select **Start automatic handoff for this departed member**. Use **Pause**, **Resume**
or **Stop** to manage the run. Select **Refresh run receipt** to see each booking's result.

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
2. 打开**团队预约**，选择原预约，再点**试算交接**。核对离队主持人、接任主持人、时间和地点类型。
   如需改期，可填写拟议开始时间。时段可用且没有现有提议时，点**创建提议**。试算和提议都不会占用时段。
3. 点**刷新交接状态**，查看版本、截止时间，以及每位预订人或来宾的决定、投递状态和可重发状态。
   有人需要新链接时，在对应行点**重发**并确认。要关闭整个版本，点**撤回**并确认。提议被拒绝、过期或撤回后，
   可点**新版本**并按需修改开始时间。换版会使旧链接和同意失效，每人都须重新回复。
4. 预订人和每个不同邮箱的来宾都要打开各自最新邮件里的私密链接。核对**当前预约**和**拟议预约**，
   选择**接受**或**拒绝**，然后点**提交决定**。预订人还可查看会共享给新主持人的已保存回答。
   仅打开链接不会记录决定。请勿转发私密链接。
5. 在原预约详情中点**刷新交接状态**。同一版本的所有参与者都已同意且时段仍可用时，点
   **确认交接**。在有参与者尚未回复、拒绝或提议过期时，核对原预约仍保持确认。
6. 确认后，原预约取消，系统创建独立的新预约。可点**查看新预约**，并刷新回执查看邮件、旧条目清理
   和新会议准备状态。参与者应以新确认邮件为准，预订人会收到新预约的管理链接。旧日历取消沿用原 UID 和组织者，
   无已保存组织者时只发文字通知。新邀请使用新 UID。两封邮件的到达顺序可能不同。

每个邮箱对同一原预约跨版本合计最多三次发送，包括首发和送达不确定的尝试。后台任务开始发送新链接时，
旧链接失效。达到发送上限后，请与参与者协调重新预约。

在**团队成员**移除主持人后，在离队审查中打开**自动交接**。也可以打开受影响的预约，点**管理自动交接**。
点**为这位已离队成员启动自动交接**，用**暂停**、**恢复**、**停止**控制队列，点**刷新运行回执**查看逐笔结果。
自动队列只处理已获全员同意的有效提议。每轮最多十笔，逐笔处理间隔
至少十秒。同一团队同时只能有一轮运行或暂停，新一轮启动间隔至少一分钟，每轮最长三十分钟，包含暂停时间。
暂停或停止在处理下一笔前生效。暂停后可由当前有权限的会话恢复。运行绑定启动或最近一次恢复的会话，
该会话切换团队或结束时，轮到下一笔处理便会因 `authorization_lost` 失败。失败后请在当前团队的有效会话中，
等启动间隔满足后为剩余符合条件的提议开启新一轮。回执保留七天。

旧日历和会议用原主持人的固定账户清理，新条目用接任主持人符合资格的账户创建。结果无法核验时，
请相应账户所有者检查。如果日历连接在交接前已被移除，该账户的所有者必须删除该日历中仍保留的副本。
后台处理期间新预约仍保持确认。提议到期后，后台逐批关闭失效提议，并在截止时间过四十八小时后清理收件邮箱
和投递记录。保留版本、已完成回执及原预约的哈希发送计数。

### 负责人验收

在已启用交接的测试实例中，准备多笔符合条件的未来预约，并使用可查看的测试收件箱。

1. 在**活动类型**打开原活动，将唯一主持人改为接任者并保存。在**团队成员**点**移除成员**并确认。打开**团队预约**，
   选择第一笔原预约，点**试算交接**，核对离队主持人、接任主持人和时段，再点**创建提议**。
2. 点**刷新交接状态**，查看版本、截止时间、预订人和来宾的决定、投递和可重发状态。核对提议面板只显示收件人角色。
   在可重发行点**重发**并确认。打开旧邮件里的链接，核对链接不可用，再从最新邮件打开提议。
3. 让预订人在私密链接中点**接受**和**提交决定**。返回原预约点**刷新交接状态**，核对有来宾未答复时
   **确认交接**不可用。让来宾点**拒绝**和**提交决定**，刷新后填入新的**开始时间**并点**新版本**。
   两人分别从新邮件打开链接并同意。回到原预约刷新，核对**确认交接**可用。
4. 在一笔已获全员同意的原预约上点**管理自动交接**，再点**为这位已离队成员启动自动交接**。
   随即点**暂停**，查看待处理回执，再点**恢复**。点**刷新运行回执**，查看逐笔结果并点**查看新预约**。
5. 对另一笔已获全员同意的提议，等启动间隔后启动新一轮，随即点**停止**。刷新运行回执，核对尚未处理的预约已停止。
   回到原预约，点**刷新交接状态**，再点**撤回**并确认，核对提议已撤回且原预约仍保持确认。
