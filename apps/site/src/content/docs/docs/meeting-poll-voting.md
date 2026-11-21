---
title: Voting in a meeting poll
description: Verify your email, choose possible meeting times, and understand poll privacy.
---

Open the public link shared by the host or the private voting link sent to your mailbox.
If you are organizing the meeting, see [Create and manage meeting polls](/docs/meeting-polls).

## Open and verify your link

You do not need an Hourmere account. A public poll link lets you enter your name, email
address and time zone to request verification. An accepted request says to check your
email, whether or not that address is already registered. It does not promise delivery.
A full poll gives the same full message for every address.

Follow the emailed link, then explicitly confirm your email. Opening a link alone never
verifies your address, votes or unsubscribes. A host invitation has its own private voter
link. Keep your voter link private: anyone who holds it can act as you within that poll.
If you lose access, use recovery with the poll ID and your email. Recovery always gives
the same response and only sends a link to an eligible existing voter; it does not enroll
someone new or extend the deadline. Email budgets and cooldowns can prevent delivery.

## Choose your times

The page shows each candidate and the voting deadline in your selected time zone. Date
and UTC-offset labels distinguish times across daylight-saving changes, including repeated
hours. Switching time zones only changes the labels; your choices still refer to the same
instants, even when the local calendar day changes.

Choose **Yes**, **If need be** or **No** for every time, answer any required questions,
and give consent before saving. A saved ballot can be changed while voting is open.
Voting does not reserve a time or guarantee that you will attend: the host may select a
subset of consenting voters who chose yes or if need be. The designated booker can manage
the whole meeting. A resulting calendar invitation may reveal attendees to one another.

If a ballot has changed in another tab, reload and review it before saving again. After
an uncertain save, check the current ballot instead of blindly repeating the submission.
Rate-limit, validation and loading errors do not mean that the poll is missing.

## Withdraw, recover and stop reminders

Withdrawal removes your votes and question answers from the poll and opts you out of
further poll email. Your contact details remain for uniqueness and possible reactivation.
While voting is open, the same voter link can reactivate your participation by submitting
a new complete ballot with renewed consent, if a place is available. Recovery does not
send a link to a withdrawn voter, so keep that original link.

A reminder email's unsubscribe link opens a separate confirmation page. Confirming stops
reminders without changing your ballot or granting access to it. It does not withdraw you
or stop every kind of poll email. Requests already accepted for delivery cannot be recalled.

After voting closes, a valid retained voter link can still show the safe poll details and
your prior ballot, but cannot change them. Invalid, expired verification, removed and
revoked links use one neutral unavailable message without revealing which case applies.
After scheduling, the poll shows the originally chosen time. Use the booking or outcome
emails for later rescheduling or cancellation updates.

## What others can see

- **Private polls:** other voters cannot see your name, email, answers or choices, and
  no aggregate totals are shown.
- **Aggregate polls:** verified voters who are still participating can see separate yes,
  if-need-be and no totals for each time. With a small group, totals can reveal someone
  else's choices. After you withdraw, aggregate totals are hidden on the page and in the
  public API.
- The host and authorized managers can see the private roster, ballots, answers and
  verification or withdrawal state. Other voters never receive that roster.

Private links carry their credential after the URL's `#`, not in query parameters. The
page sends it in a request body and does not put it in browser storage. Do not paste these
links into analytics, logs or support tickets. Poll pages are not an embeddable booking
widget. Display language is available in English, 简体中文, Deutsch, Français, Español and
Português (Brasil).

## 中文说明

请打开主持人分享的公开链接，或发送到你邮箱的个人投票链接。如果你负责组织会议，请参阅[创建和管理会议投票](/docs/meeting-polls)。

投票不需要 Hourmere 账号。通过公开链接填写姓名、邮箱和时区后，页面会统一提示检查
邮件，不透露该邮箱是否已登记，也不保证邮件送达。打开邮件链接不会自动验证或投票；
需要明确确认邮箱。找回功能使用投票 ID 和邮箱，仅向符合条件的已有投票者重发原链接，
不会新增报名、轮换链接或延长截止时间。

请为每个时间选择“可以”“必要时可以”或“不可以”，填写必填问题并同意参加后保存。
切换时区只改变日期、时间和 UTC 偏移显示，不会改变所选时段。截止前可修改选票或撤回；
撤回会清除选票和答案并停止后续投票邮件，但保留用于去重和重新参加的联系信息。
保留原链接可在截止前重新提交完整选票并再次同意参加，前提是仍有名额。
找回功能不会给已撤回的投票者发送链接。邮件中的提醒退订链接需要明确确认，只停止提醒，
不撤回选票，也不停止所有类型的投票邮件。

私密投票不向其他投票人展示姓名、邮箱、问题答案、个别选择或总票数。汇总投票只向
已验证且仍在参与的投票人展示各时段的三类票数。人数较少时，仍可能由此推断他人的选择。
撤回后，网页和公开 API 都不再显示汇总票数。
主持人及有权管理的人员可查看名单、选票和答案。投票并不预留时间，也不保证入选；
主持人可选择部分同意参加的投票者，指定的预约人可管理整场会议，最终日历邀请可能向
参会者展示其他参会者。

有效链接在投票关闭后可只读查看安全信息及自己的旧选票。无效、过期、移除及撤销的链接
显示统一的不可用信息。排定会议后，投票页面只显示最初选定的时间。后续改期或取消请查看
预约邮件或结果通知。链接中的私密凭证只放在 `#` 后并通过请求正文提交，不写入浏览器存储。
请勿转发个人投票链接，或将其放入日志、分析工具和支持工单。
