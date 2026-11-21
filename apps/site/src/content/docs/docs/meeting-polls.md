---
title: Create and manage meeting polls
description: Propose times, invite voters, review responses and schedule one meeting.
---

A meeting poll collects preferences for one meeting. You choose the time and attendees
after reviewing the responses. Proposed times stay open to ordinary bookings until you
schedule. If you received a voting link, see [Voting in a meeting poll](/docs/meeting-poll-voting).

## Create a poll

1. In the intended personal or team space, open **Meeting polls** → **Create meeting poll**.
   You need a verified email address and must own the personal event or be a current owner
   or admin of the team. Being assigned as an event host alone does not grant poll access.
2. Choose an active event type with individual booking mode and select one of its offered
   meeting lengths. Pick 2–20 available times. When a local deadline occurs twice because of
   a clock change, choose its UTC offset explicitly.
3. Set the voting deadline between 1 hour and 30 elapsed days from creation. It must be
   before the earliest proposed time, with at least the event type’s minimum booking notice
   between them.
4. Choose **Invitation only** or **Public link**. For sensitive meetings, use invitations.
   Anyone with the public link can request to join and must verify their email to vote.
   Choose **Private votes** or **Share vote totals**. Verified voters who are still
   participating in aggregate polls see separate yes, if-need-be and no totals for each
   time. In a small group, totals can reveal another person’s choice.
5. Create the poll. Copy the public voting link while it is shown. The original link cannot
   be recovered after you dismiss it or lose the response. **Replace public link** discloses
   a new link once and immediately invalidates the previous public link. Individual links
   already sent to voters are unaffected. Invitation-only polls have no public link.

The event type, duration, candidate times, deadline, admission and result visibility are
fixed after creation. Create a new poll if any of these need to change.

## Manage invitations and responses

Open a poll and use **Invitation roster** → **Invite voters** while voting is open. Enter
names and email addresses in batches of up to 40. The poll has 40 places shared by verified
voters, active invitations and unexpired public sign-ups. An unverified public sign-up
holds its place for at most one hour and counts toward the limit of three concurrent
pending sign-ups per IP per poll. Host invitations are outside that IP limit. Inviting a
pending public sign-up uses its existing place. If there is insufficient space for the
whole batch, no invitations in the batch are queued.

Resend a retained invitation while voting is open if the voter loses their link. Resending
replaces the individual voting link. Each mailbox can receive at most three host resends
per poll, at least 15 minutes apart. Voter-initiated recovery sends the existing link and
has a separate cooldown and cap. **Remove voter** clears that voter’s contact details and
ballot, revokes their links and stops queued poll mail. Only a new invitation lets a
removed voter rejoin. **Remove unverified sign-ups** clears unverified public sign-ups while
preserving host invitations. Mail already accepted for delivery cannot be recalled.

Keep the results and roster private. Authorized managers see names, email addresses,
ballots and question answers. A missing ballot is an unanswered ballot. Voting does not
send a per-vote email to the host. Invitations, verification, recovery, deadline reminders
and outcomes use the worker and shared mail budgets. See [poll mail and deadlines](/docs/notifications#meeting-poll-deadlines).

## Schedule or end voting

1. Review the results and candidate availability. **Availability unknown** means the
   current result could not be confirmed. Refresh the results before choosing a time.
2. Under **Schedule meeting**, pick an available time, one **Booker**, and any additional
   attendees allowed by the event’s guest policy. There can be at most 11 people, including
   the booker. Select only verified voters with a submitted ballot, consent, and a yes or
   if-need-be vote for the chosen time. Acknowledge any selected conditional votes.
3. Schedule the meeting. Hourmere checks current availability, event settings and voter
   eligibility again. If the poll changed, refresh and review. If the event settings that
   voters agreed to changed, start a new poll. If the request outcome is uncertain, use
   **Retry scheduling** to recover the original result.

Scheduling ends voting and creates one ordinary booking. The booker can manage the whole
meeting. Selected attendees receive normal booking mail. Eligible voters who were not
selected receive informational mail without a calendar invitation or join or manage link.
Use **View booking** to open the linked booking. The voter page shows the originally chosen
time and does not track later changes to the booking.

**Close voting** stops ballot changes and still lets you schedule. Voting also closes at
the deadline, even if the hourly cleanup has yet to record it. The creator receives a
deadline notice with a link to the results if they are still authorized. Sign in and
switch to the poll’s space if prompted. **Cancel poll** ends voting before a booking is made. Voters see
the canceled state when they open the poll. Hourmere sends no cancellation email for
an unscheduled poll. **Delete poll** removes the roster and ballots and preserves any
linked booking. Terminal poll history has no automatic expiry in the current installation.
See [self-hosting and retention](/docs/self-hosting#meeting-poll-credentials-and-recovery).

## Automate poll management

The same management permissions apply to [REST](/docs/rest#manage-meeting-polls),
[MCP](/docs/mcp#create-and-manage-meeting-polls) and [CLI](/docs/cli#manage-meeting-polls).
API-key reads allow `read`, `bookings` and `full`. Writes require `bookings` or `full`.
For the operation map, voter credentials and examples, see the
[meeting poll API guide](https://github.com/hourmere/hourmere/blob/main/docs/meeting-polls-api.md).

## Known limitations

- Polls do not reserve time, choose a winner automatically, reopen, or extend the deadline.
- Group seats, paid checkout, recurring polls, one-time booking links and embedded poll
  widgets are unavailable. The dashboard uses the event’s default location when scheduling.
  Locations that ask the booker for a phone number are unavailable for poll scheduling.
- Public-link voting verifies access to a mailbox. It cannot prevent forwarded links or
  prove that each mailbox belongs to a different person.
- Mail delivery requires working SMTP and background jobs. A queued email does not imply delivery.

## 中文说明

会议投票用于收集大家对一场会议的时间偏好。主持人根据选票决定最终时间及参会者。候选时段在正式预约前仍可被他人预约。收到链接后，请参阅[如何参与会议投票](/docs/meeting-poll-voting#中文说明)。

1. 在所属的个人或团队空间中，依次打开**会议投票**和**创建会议投票**。你的邮箱必须已验证，并且你是个人活动的所有者，或是团队当前的所有者或管理员。仅被指定为活动主持人，没有管理投票的权限。
2. 选择已启用的非团体活动类型和该活动提供的一种会议时长，再选择 2 至 20 个可用时段。截止时间须设在创建后 1 小时至 30 天内，并在最早的候选时段之前留足活动要求的最短提前预约时间。如果时钟回拨导致某个本地截止时间出现两次，请明确选择对应的 UTC 偏移量。
3. 选择**仅限受邀者**或**公开链接**，再选择**仅自己和主持人可见**或**共享投票汇总**。持有公开链接的人可以申请参与，验证邮箱后才能投票。共享汇总时，已验证且仍在参与的投票人可查看每个时段的三类票数。参与人数较少时，他人可能据此推断个别投票人的选择。涉及敏感信息的会议适合采用仅限受邀者的方式。
4. 创建后请立即复制页面显示的公开链接。关闭提示或丢失首次响应后，无法找回原链接。可通过**更换公开链接**生成新链接，旧公开链接立即失效。已通过邮件发出的个人投票链接仍可使用。仅限受邀者的投票没有公开链接。活动类型、时长、候选时间、截止时间、参与方式和结果可见范围在创建后固定，如需更改，请新建投票。

投票开放期间，可在**邀请名单**中添加受邀者的姓名、邮箱并发送邀请。每批最多 40 人，已验证的投票人、有效邀请和未过期的公开报名共用 40 个名额。未验证的公开报名最多占用名额 1 小时，同一 IP 在同一投票中最多同时占用 3 个待验证名额。主持人邀请不受此 IP 限制。邀请已报名、待验证的人会沿用其名额。剩余名额不足时，整批邀请都不会进入发送队列。

受邀者丢失链接时，可在投票开放期间重发。重发会使该受邀者的旧链接失效。每场投票中，每个邮箱至少间隔 15 分钟才能重发，最多重发 3 次。投票人自行找回链接使用单独的限额，发出的仍是原链接。**移除投票者**会删除其联系方式和选票、撤销链接并停止待发邮件。重新邀请后，对方才可再次参与。**移除未验证的公开报名**会保留主持人发出的邀请。

结果页的名单、选票和问题答案仅供有权管理投票的人查看。可用性显示**暂无法确认**时，请刷新并核对结果。选择当前可用的时间，再从符合条件的投票人中选一位**预约人**。投票人须已验证邮箱、提交选票并同意入选后参会，且在该时段回答“可以”或“必要时可以”。活动允许携带来宾时可选其他参会者，含预约人最多 11 位。选中回答“必要时可以”的人员时，需要确认这些条件票。提交后系统会再次核对时段、活动设置和参会资格。活动设置与投票时不同则需另开投票。若无法确认提交结果，可选择**重试安排**找回原结果。

安排会议后，投票结束并创建一条普通预约。预约人可以管理整场会议。入选者会收到普通预约邮件，符合条件的未入选者会收到不含日历邀请、参会链接或管理链接的结果通知。可通过**查看预约**打开关联预约。投票人页面只显示最初选定的时间，预约后续改期或取消不会更新该页面。

**结束投票**后仍可安排会议。到达截止时间时即停止投票，无需等待后台清理。系统会向仍有管理权限的创建者发送截止通知。打开通知中的链接后，请按提示登录并切换到投票所属空间。**取消投票**会结束尚未排定的投票。投票人打开页面时会看到取消状态，系统不会另发取消邮件。**删除投票**会清除名单和选票，并保留关联预约。当前系统不会自动删除已结束的投票记录。请参阅[自托管与数据保留](/docs/self-hosting#meeting-poll-credentials-and-recovery)和[投票邮件](/docs/notifications#meeting-poll-deadlines)。

通过 [REST](/docs/rest#manage-meeting-polls)、[MCP](/docs/mcp#create-and-manage-meeting-polls) 或 [CLI](/docs/cli#manage-meeting-polls) 管理投票时，仍需满足相同的管理权限。读取可用 `read`、`bookings` 或 `full` 密钥，写入需要 `bookings` 或 `full`。接口、投票凭证和用法示例见[会议投票 API 指南](https://github.com/hourmere/hourmere/blob/main/docs/meeting-polls-api.md)。

目前没有自动选出时间、重新开放、延长截止时间或预留候选时段的功能。投票不支持团体名额、付费结账、系列投票、一次性预约链接或嵌入组件。通过网页安排会议时使用活动的默认地点。需要预约人填写电话号码的地点暂不支持通过投票安排。邮箱验证只证明该人可以访问邮箱，不能阻止转发链接，也不能保证参与者各不相同。投票邮件依赖 SMTP 和后台工作进程，进入发送队列后仍可能无法送达。
